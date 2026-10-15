/**
 * What the app can enforce and run on each engine, as data
 * (issues #48, #139; docs/designs/engine-contract-and-linux-ci.md).
 *
 * The preset readiness bar (test/engine-readiness.test.cjs) asks whether an
 * engine can START as an office member. This table asks whether the app can
 * KEEP ITS PROMISES there: a member's folder stays private, background checks
 * run, and the app's own tools (mail and the rest) reach it.
 * test/engine-conformance.test.cjs refuses any engine in BUILD_ENGINES whose
 * row falls short, and checks each row against the code.
 *
 * Rows record today's code, not plans. Raise a row only in the change that
 * makes it true, with the test that proves it.
 */
import type { AgentProvider } from './agentProvider';

/** How a member's folder privacy is enforced on this engine (issue #139):
 *  - 'os-sandbox'      the OS sandbox plus the app's deny rules, so shell
 *                      commands are covered too (Claude Code on a Mac or Linux).
 *  - 'pretooluse-only' a hook checks each tool call; a shell can still reach out.
 *  - 'none'            the app enforces no folder privacy on this engine. */
export type EngineIsolation = 'os-sandbox' | 'pretooluse-only' | 'none';

export interface EngineCapabilities {
  isolation: EngineIsolation;
  /** runHiddenModel has a runner for this engine's background calls. */
  hiddenRunner: boolean;
  /** The app's MCP servers (md-mail and the rest) reach this engine (#109). */
  appMcpServers: boolean;
}

const NOTHING_YET: EngineCapabilities = { isolation: 'none', hiddenRunner: false, appMcpServers: false };

/** One row per engine; a new AgentProvider without a row fails the typecheck. */
export const ENGINE_CAPABILITIES: Readonly<Record<AgentProvider, EngineCapabilities>> = {
  // Folder rules, connector deny and MCP servers go into Claude's --settings
  // (hookSettings in src/main/hive.ts). On Windows Claude Code has no OS
  // sandbox; folderAccess.ts covers file tools there.
  claude: { isolation: 'os-sandbox', hiddenRunner: true, appMcpServers: true },
  // Codex has its own workspace sandbox and --add-dir, but no folder read
  // privacy or connector deny from the app (#48), and md-mail is not yet
  // written to its CODEX_HOME/config.toml (#109). Its hidden runner is
  // hiddenCodex.ts (#85).
  codex: { isolation: 'none', hiddenRunner: true, appMcpServers: false },
  // Gemini CLI: folders via includeDirectories, no privacy rules, no runner,
  // no usage reader yet (#113).
  gemini: { ...NOTHING_YET },
  antigravity: { ...NOTHING_YET },
  grok: { ...NOTHING_YET },
  kimi: { ...NOTHING_YET },
  qwen: { ...NOTHING_YET },
  opencode: { ...NOTHING_YET },
  crush: { ...NOTHING_YET },
  pi: { ...NOTHING_YET },
  copilot: { ...NOTHING_YET },
  cursor: { ...NOTHING_YET },
  // A custom command runs with Claude's flags today, but the app cannot know
  // what it really is, so it promises nothing.
  custom: { ...NOTHING_YET }
};

/** The capabilities an office member needs before its engine can be offered. */
export function officeGaps(engine: AgentProvider): string[] {
  const c = ENGINE_CAPABILITIES[engine];
  const gaps: string[] = [];
  if (c.isolation !== 'os-sandbox') gaps.push(`folder privacy is ${c.isolation}, needs os-sandbox`);
  if (!c.hiddenRunner) gaps.push('no runner for background checks');
  if (!c.appMcpServers) gaps.push("the app's MCP servers (mail) do not reach it");
  return gaps;
}
