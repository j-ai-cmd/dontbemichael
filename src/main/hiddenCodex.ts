import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexHiddenArgs } from '../shared/hiddenModelArgs';
import { hardKillTree } from './procKill';
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

export function runHiddenCodex(prompt: string, opts: HiddenCodexOptions): Promise<HiddenClaudeResult> {
  return new Promise((resolve) => {
    if (!prompt.trim()) { resolve({ ok: false, error: 'empty prompt' }); return; }
    if (opts.signal?.aborted) { resolve({ ok: false, error: 'cancelled' }); return; }

    const root = mkdtempSync(join(tmpdir(), 'dbm-hidden-codex-'));
    const work = join(root, 'work');
    mkdirSync(work);
    const answerFile = join(root, 'answer.txt');
    const args = codexHiddenArgs(work, answerFile);

    // Windows: an npm `.cmd` shim can't be spawned directly; route it through
    // cmd.exe, as runHiddenClaude does (#22). A real codex.exe starts directly.
    const winWrap = process.platform === 'win32' && !/\.(exe|com)$/i.test(opts.exe);
    const file = winWrap ? (process.env.ComSpec || 'cmd.exe') : opts.exe;
    const fileArgs = winWrap ? ['/c', opts.exe, ...args] : args;

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
      child = spawn(file, fileArgs, {
        cwd: work,
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
