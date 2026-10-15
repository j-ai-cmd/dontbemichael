/**
 * The separate check that an email fits a standing approval (owner,
 * 2026-10-05; shared/mailProposals.ts). A quick model with no tools reads the
 * approval and the email and answers FITS or NO; the agent that wrote the
 * email has no say. Anything else, or a check that can't run, counts as no,
 * so the email goes to the owner instead.
 */
import { randomBytes } from 'node:crypto';
import { runHiddenModel } from './hiddenModel';
import { parseStandingFit, standingFitPrompt } from '../shared/mailProposals';
import type { StandingFitCheck } from './mail';

const MODEL = 'claude-haiku-4-5';
const TIMEOUT_MS = 60_000;

export function standingFitCheck(deps: { cwd: () => string; command: () => string; env?: () => Record<string, string> | undefined; log?: (e: Record<string, unknown>) => void }): StandingFitCheck {
  return async (kind, email) => {
    try {
      const result = await runHiddenModel(standingFitPrompt(kind, email, randomBytes(6).toString('hex')), {
        model: MODEL,
        cwd: deps.cwd(),
        command: deps.command(),
        noTools: true,
        // Only the owner's own user settings: no project settings, hooks or
        // files from the folder it runs in (that folder is the app's own, too).
        settingSources: 'user',
        // A quick judgment, like the hire and focus checks.
        thinking: false,
        env: deps.env?.(),
        timeoutMs: TIMEOUT_MS
      });
      const verdict = result.ok && result.text ? parseStandingFit(result.text) : null;
      if (!verdict) deps.log?.({ kind: 'standing-check-unread', reason: result.ok ? 'unreadable' : (result.error ?? 'failed') });
      return verdict;
    } catch (e) {
      deps.log?.({ kind: 'standing-check-unread', reason: String(e).slice(0, 200) });
      return null;
    }
  };
}
