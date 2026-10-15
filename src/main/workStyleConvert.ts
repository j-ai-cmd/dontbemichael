/**
 * Converts a work style between the owner's plain description and the agent's
 * instructions (src/shared/workStyleText.ts). A hidden Claude call with no
 * tools does the rewrite; when it can't, the plain-text fallback answers and
 * says so, so hiring never waits on a sign-in problem.
 */
import { runHiddenModel } from './hiddenModel';
import {
  cleanAnswer,
  focusCheckPrompt,
  instructionsFallback,
  parseFocusCheck,
  instructionsOpening,
  plainFallback,
  roleLabel,
  suggestWorkStylePrompt,
  toInstructionsPrompt,
  toPlainPrompt,
  type SuggestRequest,
  type WorkStyleContext
} from '../shared/workStyleText';

/** Reading instructions back is a summary: Haiku. Writing them is the part the
 *  team member lives by: Sonnet. */
const PLAIN_MODEL = 'claude-haiku-4-5';
const INSTRUCTIONS_MODEL = 'claude-sonnet-5';
const TIMEOUT_MS = 90_000;
const MAX_TEXT = 8000;

export interface ConvertDeps {
  cwd: string;
  command: string;
  env?: Record<string, string>;
  log?: (event: Record<string, unknown>) => void;
}

export interface ConvertRequest {
  to: 'plain' | 'instructions';
  text: string;
  ctx: WorkStyleContext;
  /** For 'instructions': the work style being replaced, to keep its wording. */
  previous?: string;
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

/** The renderer's payload, trusted for nothing but short strings. */
export function readConvertRequest(v: unknown): ConvertRequest | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (o.to !== 'plain' && o.to !== 'instructions') return null;
  const text = str(o.text, MAX_TEXT);
  const c = (o.ctx && typeof o.ctx === 'object' ? o.ctx : {}) as Record<string, unknown>;
  const b = (c.business && typeof c.business === 'object' ? c.business : {}) as Record<string, unknown>;
  const name = str(c.name, 60).trim();
  if (!text.trim() || !name) return null;
  return {
    to: o.to,
    text,
    ctx: { name, title: str(c.title, 120) || undefined, business: { name: str(b.name, 120) || undefined, city: str(b.city, 120) || undefined }, manager: str(c.manager, 60).trim() || undefined },
    previous: str(o.previous, MAX_TEXT) || undefined
  };
}

export async function convertWorkStyle(req: ConvertRequest, deps: ConvertDeps): Promise<{ text: string; source: 'ai' | 'rules' }> {
  const fallback = () => (req.to === 'plain' ? plainFallback(req.text, roleLabel(req.ctx.title)) : instructionsFallback(req.text, req.ctx));
  try {
    const prompt = req.to === 'plain' ? toPlainPrompt(req.text, req.ctx) : toInstructionsPrompt(req.text, req.ctx, req.previous);
    const result = await runHiddenModel(prompt, {
      model: req.to === 'plain' ? PLAIN_MODEL : INSTRUCTIONS_MODEL,
      cwd: deps.cwd,
      command: deps.command,
      noTools: true,
      env: deps.env,
      timeoutMs: TIMEOUT_MS
    });
    let text = result.ok && result.text ? cleanAnswer(result.text) : '';
    // Instructions must start with the house opening line: a refusal or a
    // chatty preamble is never saved as an agent's work style.
    if (text && req.to === 'instructions') {
      const opening = instructionsOpening(req.ctx.business);
      const at = text.indexOf(opening);
      text = at >= 0 ? text.slice(at).trim() : '';
    }
    if (text) return { text, source: 'ai' };
    deps.log?.({ kind: 'work-style-fallback', to: req.to, reason: result.ok ? 'empty' : (result.error ?? 'failed') });
  } catch (e) {
    deps.log?.({ kind: 'work-style-fallback', to: req.to, reason: String(e).slice(0, 200) });
  }
  return { text: fallback(), source: 'rules' };
}

export interface FocusCheckRequest {
  name: string;
  job: string;
  focus: string;
  workStyle: string;
  others: Array<{ job: string; focus: string }>;
  /** How the agent's email may leave, from its Sending setting (main fills it). */
  sending?: string;
}

/** The renderer's payload, trusted for nothing but short strings. */
export function readFocusCheckRequest(v: unknown): FocusCheckRequest | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const name = str(o.name, 60).trim();
  const focus = str(o.focus, 1000).trim();
  if (!name || !focus) return null;
  const others = Array.isArray(o.others)
    ? o.others.slice(0, 20).map((x) => (x && typeof x === 'object' ? x as Record<string, unknown> : {}))
      .map((x) => ({ job: str(x.job, 120).trim(), focus: str(x.focus, 1000).trim() }))
      .filter((x) => x.job && x.focus)
    : [];
  return { name, job: str(o.job, 120).trim() || 'this job', focus, workStyle: str(o.workStyle, MAX_TEXT), others };
}

/**
 * Check a job's focus area against the Work style and the other jobs' focus
 * areas (schedule-focus-areas.md, FA3). `checked: false` when the check could
 * not run: the save goes ahead, as hiring does when the rewrite can't run.
 */
export async function checkFocusArea(req: FocusCheckRequest, deps: ConvertDeps): Promise<{ checked: boolean; conflict?: string }> {
  try {
    const result = await runHiddenModel(focusCheckPrompt(req), {
      model: PLAIN_MODEL,
      cwd: deps.cwd,
      command: deps.command,
      noTools: true,
      // A quick judgment, like the hire check: no extended thinking.
      thinking: false,
      env: deps.env,
      timeoutMs: TIMEOUT_MS
    });
    const verdict = result.ok && result.text ? parseFocusCheck(result.text) : null;
    if (verdict) return verdict.ok ? { checked: true } : { checked: true, conflict: verdict.conflict };
    deps.log?.({ kind: 'focus-check-skipped', reason: result.ok ? 'unreadable' : (result.error ?? 'failed') });
  } catch (e) {
    deps.log?.({ kind: 'focus-check-skipped', reason: String(e).slice(0, 200) });
  }
  return { checked: false };
}

/** The renderer's "Suggest me" payload, trusted for nothing but short strings. */
export function readSuggestRequest(v: unknown): SuggestRequest | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const c = (o.ctx && typeof o.ctx === 'object' ? o.ctx : {}) as Record<string, unknown>;
  const b = (c.business && typeof c.business === 'object' ? c.business : {}) as Record<string, unknown>;
  const name = str(c.name, 60).trim();
  const handles = str(o.handles, 1500).trim();
  if (!name || !handles) return null;
  const team = Array.isArray(o.team) ? o.team.slice(0, 20).flatMap((m) => {
    const t = (m && typeof m === 'object' ? m : {}) as Record<string, unknown>;
    const n = str(t.name, 60).trim();
    return n ? [{ name: n, title: str(t.title, 120) || undefined, handles: str(t.handles, 600) || undefined }] : [];
  }) : [];
  return {
    ctx: { name, title: str(c.title, 120) || undefined, business: { name: str(b.name, 120) || undefined, city: str(b.city, 120) || undefined }, manager: str(c.manager, 60).trim() || undefined },
    handles,
    businessType: str(o.businessType, 80) || undefined,
    team
  };
}

/**
 * "Suggest me" on the hire wizard: a first work style in the owner's plain
 * form, for them to review and edit (owner, 2026-10-03). Sonnet writes it, as
 * it writes instructions, without extended thinking so the owner waits
 * seconds. Empty when the call can't run: the owner writes their own.
 */
export async function suggestWorkStyle(
  req: SuggestRequest,
  deps: ConvertDeps,
  live?: { onText?: (text: string) => void; signal?: AbortSignal }
): Promise<{ text: string; cancelled?: boolean }> {
  try {
    const result = await runHiddenModel(suggestWorkStylePrompt(req), {
      model: INSTRUCTIONS_MODEL,
      cwd: deps.cwd,
      command: deps.command,
      noTools: true,
      thinking: false,
      env: deps.env,
      timeoutMs: TIMEOUT_MS,
      // The draft streams into the owner's field while it is written.
      onScreenText: live?.onText,
      signal: live?.signal
    });
    if (result.error === 'cancelled') return { text: '', cancelled: true };
    const text = result.ok && result.text ? cleanAnswer(result.text) : '';
    if (text) return { text };
    deps.log?.({ kind: 'work-style-suggest-failed', reason: result.ok ? 'empty' : (result.error ?? 'failed') });
  } catch (e) {
    deps.log?.({ kind: 'work-style-suggest-failed', reason: String(e).slice(0, 200) });
  }
  return { text: '' };
}
