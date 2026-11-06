/**
 * Goals: the pure rules (no I/O). Who may do what, which state moves are
 * legal, what a complete verdict is, which evidence path is acceptable, and
 * the wake cap. `service.ts` applies them inside one row lock per write.
 */
import { GOAL_LIMITS, GOAL_OPEN_STATES, type GoalCapabilities, type GoalState } from '@kortix/api-contract';
import type { ProjectGoalCriterion } from '@kortix/db';
import { parseDurationSeconds } from '@kortix/manifest-schema';
import type { GoalRow } from './store';

/**
 * Who calls. The route derives it from the credential, never from a body:
 * - `user`: a person (browser JWT or a PAT not bound to a session);
 * - `session`: an agent session credential bound to `sessionId`;
 * - `platform`: the API itself (reminder fire, reconciler, successor adoption).
 */
export type GoalActor =
  | { kind: 'user'; userId: string; isAdmin: boolean }
  | { kind: 'session'; sessionId: string; userId: string }
  | { kind: 'platform' };

export function actorKindOf(actor: GoalActor): 'user' | 'session' | 'platform' {
  return actor.kind;
}

export function actorIdOf(actor: GoalActor): string | null {
  if (actor.kind === 'user') return actor.userId;
  if (actor.kind === 'session') return actor.sessionId;
  return null;
}

export function isOpenState(state: string): boolean {
  return (GOAL_OPEN_STATES as readonly string[]).includes(state);
}

/** A person who manages this goal: its creator, its assigned user, or a project admin. */
export function isGoalManager(goal: Pick<GoalRow, 'createdByUserId' | 'assignedUserId'>, actor: GoalActor): boolean {
  if (actor.kind !== 'user') return false;
  return actor.isAdmin || actor.userId === goal.createdByUserId || (goal.assignedUserId !== null && actor.userId === goal.assignedUserId);
}

/** Every role a session held on this goal. */
export function sessionRoles(goal: Pick<GoalRow, 'sessions'>, sessionId: string): Set<'owner' | 'verifier'> {
  return new Set(goal.sessions.filter((s) => s.id === sessionId).map((s) => s.role));
}

/** A blocked reason a person's resume clears. `wake_cap` clears by itself on the next UTC day; `setup` by the reconciler. */
/** Blocks a person clears with Resume. `owner_lost` needs a new owner: Restart. */
const RESUMABLE_BLOCKS = new Set(['credits', 'flag_off', 'session_cap', 'storage']);

export function capabilitiesFor(goal: GoalRow, actor: GoalActor): GoalCapabilities {
  const manager = isGoalManager(goal, actor);
  const open = isOpenState(goal.state);
  const paused = goal.pausedAt !== null;
  const ownerLost = goal.blockedReason === 'owner_lost' && open;
  // A blocked goal runs nothing, so the one control it shows is the way out (Resume or Restart), not Pause.
  const stuck = ownerLost || (goal.blockedReason !== null && RESUMABLE_BLOCKS.has(goal.blockedReason));
  return {
    read: true,
    edit: manager && open,
    pause: manager && open && !paused && !stuck,
    resume: manager && open && (paused || (goal.blockedReason !== null && RESUMABLE_BLOCKS.has(goal.blockedReason))),
    stop: manager && open,
    restart: manager && (goal.state === 'stopped' || ownerLost),
    answer: manager && open && !paused && !ownerLost,
    edit_criteria: manager && open,
  };
}

/** Criteria from text lines: ids `c1..cN`, nothing reported or verified. */
export function freshCriteria(texts: readonly string[]): ProjectGoalCriterion[] {
  return texts.map((text, i) => ({ id: `c${i + 1}`, text: text.trim(), reported_met: false, evidence: null, verified: false }));
}

/** Clean, non-empty criterion lines; null when the count is outside 1–8 or a line is too long. */
export function criteriaTextsValid(texts: readonly string[]): string | null {
  const clean = texts.map((t) => t.trim()).filter(Boolean);
  if (clean.length < GOAL_LIMITS.criteria_min) return `A goal needs at least ${GOAL_LIMITS.criteria_min} done criterion.`;
  if (clean.length > GOAL_LIMITS.criteria_max) return `A goal has at most ${GOAL_LIMITS.criteria_max} done criteria.`;
  if (clean.some((t) => t.length > GOAL_LIMITS.criterion_chars)) return `A criterion has at most ${GOAL_LIMITS.criterion_chars} characters.`;
  return null;
}

/**
 * An evidence path the owner may report: relative to the goal folder, under
 * `evidence/`, no `..`, no `.` segment, no backslash, no empty segment.
 */
export function evidencePathError(path: string): string | null {
  if (!path.startsWith('evidence/')) return `Evidence "${path}" must be a path under evidence/.`;
  if (path.includes('\\') || path.includes('\0')) return `Evidence "${path}" has a character a path may not have.`;
  const segments = path.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return `Evidence "${path}" must not contain "..", "." or an empty segment.`;
  if (segments.length < 2 || !segments[segments.length - 1]) return `Evidence "${path}" must name a file under evidence/.`;
  return null;
}

/**
 * A verdict covers the CURRENT criteria exactly once each. Returns every
 * reason it does not; empty when it does.
 */
export function verdictViolations(criteria: readonly ProjectGoalCriterion[], results: readonly { criterion_id: string }[]): string[] {
  const ids = new Set(criteria.map((c) => c.id));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of results) {
    if (!ids.has(r.criterion_id)) out.push(`Criterion ${r.criterion_id} is not a criterion of this goal.`);
    else if (seen.has(r.criterion_id)) out.push(`Criterion ${r.criterion_id} has more than one result.`);
    seen.add(r.criterion_id);
  }
  for (const id of ids) if (!seen.has(id)) out.push(`Criterion ${id} has no result.`);
  return out;
}

/** Why the owner may not ask for verification yet; empty when it may. File existence is checked separately. */
export function verificationReadinessViolations(criteria: readonly ProjectGoalCriterion[]): string[] {
  if (criteria.length === 0) return ['The goal has no done criteria.'];
  const out: string[] = [];
  for (const c of criteria) {
    if (!c.reported_met) out.push(`Criterion ${c.id} is not reported met.`);
    else if (!c.evidence) out.push(`Criterion ${c.id} has no evidence file.`);
    else {
      const err = evidencePathError(c.evidence);
      if (err) out.push(err);
    }
  }
  return out;
}

/** `heartbeat_every` as seconds, bounded below by GOAL_LIMITS; null when it does not parse or is too short. */
export function heartbeatSeconds(value: string): number | null {
  const seconds = parseDurationSeconds(value);
  if (!seconds || seconds < GOAL_LIMITS.heartbeat_min_minutes * 60) return null;
  if (seconds > 366 * 86400) return null;
  return seconds;
}

/** The UTC calendar day of `at`, `YYYY-MM-DD`. */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** 0–15 min, the same every day for one goal: capped goals do not all wake at 00:00:00 UTC. */
export function midnightJitterMs(goalId: string): number {
  let h = 0;
  for (const ch of goalId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (h % (15 * 60)) * 1000;
}

/** The next UTC midnight after `at`, plus the goal's jitter. */
export function nextUtcMidnight(at: Date, goalId: string): Date {
  const next = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1);
  return new Date(next + midnightJitterMs(goalId));
}

export type WakeDecision =
  | { admit: true; wakeDay: string; wakesToday: number; chase: boolean }
  | { admit: false; reason: 'flag_off' | 'closed' | 'paused' | 'waiting' | 'wake_cap' | 'setup'; wakeDay: string; wakesToday: number };

/**
 * May an automatic wake run a turn now? The cap counts admitted wakes per
 * UTC day of `now`; a new day starts the count at 0. A `waiting_on_user`
 * goal wakes only to chase, once `chase_at` is due.
 */
export function decideWake(goal: GoalRow, input: { now: Date; flagOn: boolean }): WakeDecision {
  const day = utcDay(input.now);
  const wakesToday = goal.wakeDay === day ? goal.wakesToday : 0;
  if (!input.flagOn) return { admit: false, reason: 'flag_off', wakeDay: day, wakesToday };
  if (!isOpenState(goal.state)) return { admit: false, reason: 'closed', wakeDay: day, wakesToday };
  if (goal.pausedAt) return { admit: false, reason: 'paused', wakeDay: day, wakesToday };
  if (goal.blockedReason === 'setup') return { admit: false, reason: 'setup', wakeDay: day, wakesToday };
  const chase = goal.state === 'waiting_on_user' && goal.chaseAt !== null && goal.chaseAt.getTime() <= input.now.getTime();
  if (goal.state !== 'active' && goal.state !== 'verifying' && !chase) return { admit: false, reason: goal.state === 'draft' ? 'closed' : 'waiting', wakeDay: day, wakesToday };
  if (wakesToday >= goal.maxWakesPerDay) return { admit: false, reason: 'wake_cap', wakeDay: day, wakesToday };
  return { admit: true, wakeDay: day, wakesToday: wakesToday + 1, chase };
}

/** The first line of a brief is the title; the rest is the context. */
export function splitBrief(brief: string): { title: string; context: string } {
  const lines = brief.replace(/\r\n/g, '\n').trim().split('\n');
  const title = (lines[0] ?? '').replace(/^#+\s*/, '').trim().slice(0, GOAL_LIMITS.title_chars) || 'Goal';
  return { title, context: lines.slice(1).join('\n').trim() };
}

/** A goal folder name from its title: lowercase words joined by `-`, at most 5. Same rule as `kortix goals new`. */
export function goalSlug(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .split('-')
      .slice(0, 5)
      .join('-') || 'goal'
  );
}

/** Agents that have no Files cannot work a goal. */
export const NO_FILES_AGENTS = new Set(['mykortix', 'meta']);

interface GoalAgentCandidate {
  name: string;
  mode?: string | null;
  enabled?: boolean;
  hidden?: boolean;
  platform?: boolean;
  sandbox?: string | null;
}

/**
 * The agents that can work a goal, in the order to try them when none is
 * named: the project's default if it has Files (My Kortix does not), then
 * primary agents, then the rest. The caller authorizes each in turn and keeps
 * the first it may run.
 */
export function goalAgentCandidates(
  config: { default_agent?: string | null; agents?: readonly GoalAgentCandidate[] } | null | undefined,
): string[] {
  const fits = (config?.agents ?? []).filter(
    (a) => a.enabled !== false && !a.hidden && !a.platform && !NO_FILES_AGENTS.has(a.name) && !NO_FILES_AGENTS.has(a.sandbox ?? ''),
  );
  const rank = (a: GoalAgentCandidate) => (a.name === config?.default_agent ? 0 : a.mode !== 'subagent' ? 1 : 2);
  return [...fits].sort((x, y) => rank(x) - rank(y)).map((a) => a.name);
}

/** The heartbeat prompt. The marker `Goal wake: <box folder>.` is what `kortix goals` and older boxes look for. */
export function goalWakePrompt(boxFolder: string, goalId: string): string {
  return `Goal wake: ${boxFolder}. Load the kortix-goals skill and run one wake (goal ${goalId}).`;
}

export function chaseBounds(now: Date): { min: Date; max: Date } {
  return {
    min: new Date(now.getTime() + GOAL_LIMITS.chase_min_minutes * 60_000),
    max: new Date(now.getTime() + GOAL_LIMITS.chase_max_days * 86_400_000),
  };
}

export const GOAL_STATES: readonly GoalState[] = ['draft', 'active', 'waiting_on_user', 'verifying', 'done', 'stopped'];
