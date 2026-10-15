import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexHiddenArgs } from '../shared/hiddenModelArgs';
import { hardKillTree } from './procKill';
import { buildCmdCommandLine, type ProcessLaunch } from './pty';
import type { HiddenClaudeResult } from './hiddenClaude';

/**
 * A hidden background call on Codex (issue #85): `codex exec` with every tool
 * off, run in an empty folder made for this call and removed afterwards. The
 * prompt goes in on stdin and the answer comes back through `-o`, so nothing
 * is read off a screen and no prompt text is ever an argument.
 *
 * Only runHiddenModel calls this, and only for calls with noTools set.
 */

export interface HiddenCodexOptions {
  /** The resolved codex executable. */
  exe: string;
  /** The full environment for the process. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Total timeout ms. Default 180000. */
  timeoutMs?: number;
  /** Stops the call: the process is killed and the result is 'cancelled'. */
  signal?: AbortSignal;
}

/** How to start codex. On Windows an npm install puts a `codex.cmd` launcher
 *  on PATH, which only cmd.exe can start; it gets the same quoting agents'
 *  terminals use (buildCmdCommandLine), so a folder under a user name with a
 *  space stays one argument. A real codex.exe, and every other platform,
 *  starts directly with an argument array. */
export function codexLaunch(platform: NodeJS.Platform, exe: string, args: string[], comSpec = 'cmd.exe'): ProcessLaunch {
  if (platform === 'win32' && !/\.(exe|com)$/i.test(exe)) {
    return { file: comSpec, args: [buildCmdCommandLine(exe, args)], windowsVerbatimArguments: true };
  }
  return { file: exe, args };
}

export function runHiddenCodex(prompt: string, opts: HiddenCodexOptions): Promise<HiddenClaudeResult> {
  return new Promise((resolve) => {
    if (!prompt.trim()) { resolve({ ok: false, error: 'empty prompt' }); return; }
    if (opts.signal?.aborted) { resolve({ ok: false, error: 'cancelled' }); return; }

    let root: string;
    try {
      root = mkdtempSync(join(tmpdir(), 'dbm-hidden-codex-'));
      mkdirSync(join(root, 'work'));
    } catch (e) {
      // No temp folder (full disk, no access): the caller's fallback answers.
      resolve({ ok: false, error: e instanceof Error ? e.message : String(e) });
      return;
    }
    const work = join(root, 'work');
    const answerFile = join(root, 'answer.txt');
    const launch = codexLaunch(process.platform, opts.exe, codexHiddenArgs(work, answerFile), process.env.ComSpec || 'cmd.exe');

    let settled = false;
    let child: ChildProcess | undefined;
    let timer: NodeJS.Timeout | undefined;

    const finish = (r: HiddenClaudeResult, stop: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      // The npm `codex` is a launcher that starts the native binary as its own
      // child: killing only the launcher would leave the model call running.
      // On a stop, kill the whole tree (its process group on POSIX, taskkill
      // /T on Windows). A process that ended on its own is left alone.
      if (stop && child?.pid) hardKillTree(child.pid);
      try { rmSync(root, { recursive: true, force: true }); } catch { /* next time */ }
      resolve(r);
    };
    const onAbort = () => finish({ ok: false, error: 'cancelled' }, true);

    try {
      child = spawn(launch.file, launch.args, {
        cwd: work,
        windowsVerbatimArguments: launch.windowsVerbatimArguments,
        env: (opts.env ?? process.env) as NodeJS.ProcessEnv,
        // Codex's progress output repeats the prompt (the owner's email, a
        // member's notes), so none of it is kept: an error names only the exit.
        stdio: ['pipe', 'ignore', 'ignore'],
        // Its own process group on POSIX, so a stop reaches every descendant.
        detached: process.platform !== 'win32',
        windowsHide: true
      });
    } catch (e) {
      try { rmSync(root, { recursive: true, force: true }); } catch { /* next time */ }
      resolve({ ok: false, error: e instanceof Error ? e.message : String(e) });
      return;
    }

    timer = setTimeout(() => finish({ ok: false, error: 'hidden session timed out' }, true), opts.timeoutMs ?? 180_000);
    opts.signal?.addEventListener('abort', onAbort);

    child.on('error', (e) => finish({ ok: false, error: e.message }, false));
    child.on('close', (code, signal) => {
      let text = '';
      try { text = readFileSync(answerFile, 'utf8').trim(); } catch { /* no answer written */ }
      if (text) { finish({ ok: true, text }, false); return; }
      finish({ ok: false, error: `no answer from codex (exit ${code ?? signal})` }, false);
    });

    child.stdin?.on('error', () => { /* the process ended first; close reports it */ });
    child.stdin?.end(prompt);
  });
}
