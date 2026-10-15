/**
 * Which runner serves a hidden background call (the memory tidy up, the
 * standing approval check, the hire check, the Work style helpers), and the
 * Codex arguments for one (issue #85, docs/designs/engine-contract-and-linux-ci.md).
 *
 * Pure and electron-free, so the tests check it without spawning anything.
 */
import { inferAgentProvider, type AgentProvider } from './agentProvider';

export type HiddenRunner = 'claude' | 'codex';

/** The engine a hidden call runs on: an explicit engine, else the one the
 *  office command names (the same rule the rest of the app uses). */
export function hiddenEngine(command: string | undefined, explicit?: unknown): AgentProvider {
  return inferAgentProvider(command, explicit);
}

/** Claude serves every call. A custom command keeps the Claude path it always
 *  had (a wrapper around claude). Codex serves only calls with every tool off:
 *  its runner turns every tool off, so a call that needs tools is never run
 *  there. Any other engine has no runner yet: null, and the caller's own
 *  fallback answers. */
export function hiddenRunnerFor(engine: AgentProvider, noTools: boolean): HiddenRunner | null {
  if (engine === 'claude' || engine === 'custom') return 'claude';
  if (engine === 'codex' && noTools) return 'codex';
  return null;
}

/** `codex exec` with every tool off, as tested in issue #85 (codex-cli
 *  0.162.1): no session kept, no user config, a read only sandbox in an empty
 *  folder, no shell, apps, browser, computer or web search, and the last
 *  message written to `answerFile`. The prompt is read from stdin (`-`), so no
 *  prompt text is ever an argument. */
export function codexHiddenArgs(workDir: string, answerFile: string): string[] {
  return [
    'exec',
    '--ephemeral',
    '--ignore-user-config',
    '--skip-git-repo-check',
    '-s', 'read-only',
    '-C', workDir,
    '--disable', 'shell_tool',
    '--disable', 'unified_exec',
    '--disable', 'apps',
    '--disable', 'browser_use',
    '--disable', 'computer_use',
    '-c', 'web_search=disabled',
    '-o', answerFile,
    '-'
  ];
}
