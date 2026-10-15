import { runHiddenClaude, type HiddenClaudeOptions, type HiddenClaudeResult } from './hiddenClaude';
import { runHiddenCodex } from './hiddenCodex';
import { resolveCommand, userShellPath } from './shellEnv';
import { tokenizeCommand } from '../shared/commandLine';
import { hiddenEngine, hiddenRunnerFor } from '../shared/hiddenModelArgs';
import type { AgentProvider } from '../shared/agentProvider';

/**
 * One entry point for every hidden background call, on whatever engine the
 * office runs (issue #85, docs/designs/engine-contract-and-linux-ci.md).
 *
 * - Claude (and a custom command) keeps runHiddenClaude, with the same options.
 * - Codex runs `codex exec` with every tool off (hiddenCodex.ts), for calls
 *   with noTools set. Claude only options (model, settings, thinking, the live
 *   preview) have no Codex meaning and are not passed on.
 * - Any other engine answers HIDDEN_UNAVAILABLE at once, and the caller's own
 *   fallback runs, instead of spawning that engine with Claude's flags.
 *
 * The trust check in index.ts stays on runHiddenClaude on purpose: it is
 * Claude only whatever engine the office runs.
 */

export interface HiddenModelOptions extends HiddenClaudeOptions {
  /** The engine to run on. Defaults to the one `command` names. */
  engine?: AgentProvider;
}

/** The error of a call no runner on this engine can serve. */
export const HIDDEN_UNAVAILABLE = 'unavailable';

export async function runHiddenModel(prompt: string, opts: HiddenModelOptions): Promise<HiddenClaudeResult> {
  const { engine: explicit, ...claudeOpts } = opts;
  const engine = hiddenEngine(opts.command, explicit);
  switch (hiddenRunnerFor(engine, opts.noTools === true)) {
    case 'claude':
      return runHiddenClaude(prompt, claudeOpts);
    case 'codex': {
      // The office's own codex binary when its command names codex, else plain codex.
      const named = tokenizeCommand(opts.command ?? '')[0];
      const binary = named && hiddenEngine(opts.command) === 'codex' ? named : 'codex';
      return runHiddenCodex(prompt, {
        exe: resolveCommand(binary),
        env: { ...process.env, PATH: userShellPath(), ...(opts.env ?? {}) },
        timeoutMs: opts.timeoutMs,
        signal: opts.signal
      });
    }
    default:
      return { ok: false, error: HIDDEN_UNAVAILABLE };
  }
}
