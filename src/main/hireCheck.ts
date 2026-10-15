/**
 * The distinct job check the hire wizard runs on Review (design D6: "make a much
 * more thorough check of existing agent profiles and only allow if the new hire
 * job description is sufficiently distinct or particular such as bound to a
 * specific mailbox or specific topic").
 *
 * A hidden Claude call (Haiku, no tools: it only reads text) compares the new
 * job with every teammate's profile and answers JSON. When the call fails or
 * answers junk, the instant rules decide instead and the verdict says so, so a
 * sign-in problem never blocks hiring for good.
 */
import { runHiddenModel } from './hiddenModel';
import {
  distinctPrompt,
  parseDistinctAnswer,
  overlapsByRules,
  type DistinctVerdict,
  type JobProfile
} from '../shared/hireTemplates';

const CHECK_MODEL = 'claude-haiku-4-5';
const CHECK_TIMEOUT_MS = 60_000;
const MAX_TEAM = 40;

export interface HireCheckDeps {
  cwd: string;
  command: string;
  env?: Record<string, string>;
  log?: (event: Record<string, unknown>) => void;
  /** Stops the check when the owner moves on to another job (ship review). */
  signal?: AbortSignal;
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');

/** The renderer's payload, trusted for nothing but short strings. */
export function readJobProfile(v: unknown): JobProfile | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const name = str(o.name, 60).trim();
  if (!name) return null;
  return {
    name,
    title: str(o.title, 120),
    routing: str(o.routing, 1500),
    workStyle: str(o.workStyle, 6000),
    mailbox: str(o.mailbox, 200) || undefined
  };
}

export function rulesVerdict(job: JobProfile, team: JobProfile[]): DistinctVerdict {
  const overlapsWith = overlapsByRules(job, team);
  return { distinct: overlapsWith.length === 0, overlapsWith, why: '', source: 'rules' };
}

export async function checkDistinct(job: JobProfile, teamIn: JobProfile[], deps: HireCheckDeps): Promise<DistinctVerdict> {
  const team = teamIn.slice(0, MAX_TEAM);
  if (team.length === 0) return { distinct: true, overlapsWith: [], why: '', source: 'rules' };
  try {
    const result = await runHiddenModel(distinctPrompt(job, team), {
      model: CHECK_MODEL,
      cwd: deps.cwd,
      command: deps.command,
      noTools: true,
      // A quick judgment: no extended thinking, so the verdict takes seconds.
      thinking: false,
      env: deps.env,
      timeoutMs: CHECK_TIMEOUT_MS,
      signal: deps.signal
    });
    // Stopped because the owner picked another job: nobody reads this answer.
    if (!result.ok && result.error === 'cancelled') return rulesVerdict(job, team);
    const verdict = result.ok && result.text ? parseDistinctAnswer(result.text, team.map((m) => m.name)) : null;
    // The rules always count too, so the model can't be talked past a job
    // whose what to send reads like a teammate's.
    if (verdict) {
      const overlapsWith = [...new Set([...verdict.overlapsWith, ...overlapsByRules(job, team)])];
      return { ...verdict, distinct: overlapsWith.length === 0, overlapsWith };
    }
    deps.log?.({ kind: 'hire-check-fallback', reason: result.ok ? 'no verdict' : (result.error ?? 'failed') });
  } catch (e) {
    deps.log?.({ kind: 'hire-check-fallback', reason: String(e).slice(0, 200) });
  }
  return rulesVerdict(job, team);
}
