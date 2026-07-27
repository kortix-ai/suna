/**
 * AGI liveness — the pure half of spec §8 (R-28 … R-33).
 *
 * Everything here is a total function over a task row plus the facts the store
 * fetched for it. No database, no Hono context, no clock of its own — the caller
 * passes `now`. That is deliberate: liveness is the one part of the AGI surface
 * where a wrong answer is silent (a stalled task simply never moves), so the
 * decision procedure has to be directly testable against every branch.
 *
 * Two things are decided here and nowhere else:
 *
 *   • {@link resolveTaskLiveness} — R-28's exhaustive list of valid answers to
 *     "what moves this forward next?", evaluated in order. Anything that matches
 *     none of them is `stalled` (R-29), which is a REPORT, never a retry.
 *   • {@link stallFingerprint} — the identity of a stalled STATE. It is what
 *     bounds recovery to one automatic continuation (R-32), so it must be
 *     derivable from evidence alone: no timestamps, no session id, no counter.
 *     Feed it the same evidence twice and it MUST return the same string.
 */
import { createHash } from 'node:crypto';
import {
  namesThreshold,
  resolveGoalStall,
  type GoalMetricSummary,
  type GoalStallRule,
} from '../observations/wire';
import {
  isRequestAnswerOverdue,
  requestUnansweredForMs,
  resolveRequestUnansweredAfterMs,
} from '../requests/wire';
import { isTerminalTaskStatus, type AgiTaskRow } from '../tasks/wire';

/**
 * The answer to "what moves this forward next?".
 *
 * `settled` is outside R-28 (it scopes itself to non-terminal tasks) and exists
 * so callers never have to special-case done/cancelled before asking. The five
 * middle values are R-28's answers 1–5.
 *
 * `awaiting_response` is answer 5 — "a pending approval or question awaiting a
 * specific responder" — and it arrived exactly as this comment used to predict:
 * as a sixth value here and a branch below, over the task edge in
 * `agi_requests` (spec §4.3), and NOT as a second liveness model. It is distinct
 * from `human` on purpose: `human` means a person owns the work, while
 * `awaiting_response` means a person owes an answer and nothing will move until
 * they give it.
 */
export const LIVENESS_STATES = [
  'settled',
  'working',
  'blocked',
  'human',
  'awaiting_response',
  'awaiting_trigger',
  'stalled',
] as const;
export type LivenessState = (typeof LIVENESS_STATES)[number];

/**
 * Why a task matched none of R-28's answers. These are the strings a human reads
 * when they ask "what is stuck and why", so each one names the evidence rather
 * than the conclusion.
 */
export const STALL_REASONS = [
  /** A claim that still looks live, held by a session that has already ended.
   *  This is the overnight failure the whole module exists for. */
  'claiming_session_terminal',
  /** The claim's TTL passed. The row still names the session that dropped it,
   *  which is the whole point: somebody was on this and is not any more.
   *
   *  This is deliberately NOT rescued by a trigger or a goal. See
   *  {@link resolveTaskLiveness} — a future fire is answer 2 for work nobody has
   *  started, never for work that was started and abandoned. */
  'claim_expired',
  /** The row asserts a session is working this RIGHT NOW (`status: doing`) and
   *  no session holds it. The claim was released — by the session-terminal
   *  writeback, by the sweep, or by the agent itself — and nothing moved the
   *  status with it.
   *
   *  This is the state the sweep's own fix creates, and the reason R-32's bound
   *  used to be unreachable: releasing a dead lease erases the evidence in the
   *  row, so the very next verdict read `awaiting_trigger` and recovery was
   *  skipped for a task left mid-flight with nobody on it. */
  'abandoned_in_flight',
  /** Every unresolved `blocked_by` edge points at a cancelled or missing task.
   *  R-17: a cancelled blocker does NOT satisfy the dependency, so the edge is
   *  unresolved forever — waiting on it is not a live path. */
  'dead_blocker',
  /** Assigned to an agent, unclaimed, no trigger lineage and no goal: nothing in
   *  the system is scheduled to look at it again. */
  'no_live_path',
  /** R-12g. The task carries a pending request for a human act, and that request
   *  reached no surface a human sees — no channel message, no addressee, nothing
   *  but a row. A task with an undelivered ask is NOT rescued by its goal's next
   *  `push`: the next fire re-derives the same block and hits the same wall. */
  'request_undelivered',
  /** The ask reached a named human and that human has not answered it within the
   *  window `DEFAULT_REQUEST_UNANSWERED_HOURS` sets (configurable, and echoed on
   *  every verdict as `requestUnansweredAfterMs`). R-28 answer 5 says
   *  "AWAITING a specific responder", and waiting is a thing that stops being
   *  true: a delivery is one event, not a standing promise that somebody will
   *  act, and R-12g deliberately buys no second nag.
   *
   *  Without this, one unread inbox row propped a task up as healthy forever —
   *  measured at 45 days on a workspace whose board reported `stalled_count: 0`.
   *  It is the same false-healthy verdict `request_undelivered` closes, reached
   *  from the other side, and it is reported separately because the fix is
   *  different: go and answer the ask, rather than go and deliver it. */
  'request_unanswered',
  /** R-12g's other half, and the one that actually fires in production. The task
   *  says it is `blocked`, names no blocking task (R-16: `blocked_by` is how a
   *  dependency is stated), and carries no pending human request. So whatever it
   *  is waiting on was written down in prose — a session log, a task body — and
   *  R-31 is explicit that prose is not a control-plane act.
   *
   *  This is the overnight failure §4.3 was written about, exactly as it occurs:
   *  a 07:00 push discovers it needs a Search Console grant, mints the fill-in
   *  URL, writes it where only that session can see it, and marks the task
   *  blocked. Before §4.3 that read as `awaiting_trigger` — perfectly healthy —
   *  because the goal's standing push does keep firing. It just can never
   *  advance. */
  'blocked_without_cause',
] as const;
export type StallReason = (typeof STALL_REASONS)[number];

/**
 * Statuses whose meaning is "a session is working this right now".
 *
 * One member, and the narrowness is the point. `backlog` and `todo` say nobody
 * has started; `review` says the work is done and something else is owed;
 * `blocked` has its own reason. Only `doing` makes a claim about the present
 * tense that a claimless row contradicts, and a stall detector that condemned
 * `review` or `todo` for the same reason would bury the real signal.
 */
export const IN_FLIGHT_TASK_STATUSES = ['doing'] as const;

export function isInFlightTaskStatus(status: string): boolean {
  return (IN_FLIGHT_TASK_STATUSES as readonly string[]).includes(status);
}

/**
 * What we know about the session named by `claim_session_id`.
 *
 * `unknown` is NOT treated as terminal. A claim id that does not resolve to a
 * project session is still inside its TTL and may be a live claimant this API
 * cannot see; calling it dead would break R-19's "a claim held by a live session
 * MUST NOT be broken". Expiry alone retires it, which is exactly the bound the
 * claim was designed around.
 */
export type ClaimSessionState = 'active' | 'terminal' | 'unknown';

/** Session statuses that mean the session will never do anything again. Mirrors
 *  projects/maintenance.ts's TERMINAL_SESSION_STATUSES. */
export const TERMINAL_SESSION_STATUSES = ['stopped', 'completed', 'failed'] as const;

export function classifyClaimSession(status: string | null | undefined): ClaimSessionState {
  if (status === null || status === undefined) return 'unknown';
  return (TERMINAL_SESSION_STATUSES as readonly string[]).includes(status) ? 'terminal' : 'active';
}

// ─── R-33: did the session make progress? ───────────────────────────────────

/**
 * The evidence that a claiming session did something.
 *
 * R-30's prohibitions hold here by CONSTRUCTION rather than by a check: none of
 * provisioning a sandbox, cloning a repo, reading context, or running a
 * background process writes a task row, so none of them can produce any of these
 * values. R-31 holds the same way — prose in a session log is not a row.
 */
export type ProgressEvidence =
  /** The task reached done/cancelled. */
  | 'task_terminal'
  /** The session created work underneath it. */
  | 'children_created'
  /** The row was written after the claim — a status change, or a reason recorded
   *  in the body. R-33 accepts either. */
  | 'task_written'
  /** Nothing wrote this row after the claim. R-33's no-progress case. */
  | 'untouched_since_claim';

export interface ClaimProgress {
  progressed: boolean;
  evidence: ProgressEvidence;
}

/**
 * R-33, decided from facts the store already gathered.
 *
 * `writtenSinceClaim` is exact rather than heuristic because `claimTask` sets
 * `claimed_at` and `updated_at` from the same `now()` in one statement — so
 * immediately after a claim (or a heartbeat re-claim, which resets BOTH) they are
 * equal, and any later write to the row strictly advances only `updated_at`.
 * Equality therefore means "nothing but the claim itself has ever touched this
 * row", which is precisely a session that ended without changing a status or
 * recording why it could not. It arrives as a boolean rather than two Dates
 * because the comparison must happen in SQL to keep sub-millisecond precision —
 * see AgiTaskWithClaimFacts.
 *
 * The limit is honest and worth stating: this sees writes to THIS task and tasks
 * parented under it. A session that recorded its reason somewhere else entirely
 * reads as no-progress. That direction is the safe one — R-29 wants a stall
 * surfaced, and a surfaced stall costs a human one glance.
 */
export function classifyClaimProgress(input: {
  task: Pick<AgiTaskRow, 'status'>;
  writtenSinceClaim: boolean;
  childrenCreatedAfterClaim: number;
}): ClaimProgress {
  if (isTerminalTaskStatus(input.task.status)) {
    return { progressed: true, evidence: 'task_terminal' };
  }
  if (input.childrenCreatedAfterClaim > 0) {
    return { progressed: true, evidence: 'children_created' };
  }
  if (input.writtenSinceClaim) return { progressed: true, evidence: 'task_written' };
  return { progressed: false, evidence: 'untouched_since_claim' };
}

// ─── R-32: the identity of a stalled state ──────────────────────────────────

export const STALL_FINGERPRINT_PREFIX = 'agi-stall:v1';

/**
 * R-32's "the same stalled state", as one deterministic string.
 *
 * It is fed to `origin_fingerprint`, so the partial unique index on
 * (workspace_id, origin_fingerprint) is what physically enforces "at most ONE
 * automatic continuation" — the second attempt loses an INSERT rather than
 * consulting a counter that could drift.
 *
 * The session id is deliberately NOT an input. Including it would make every
 * fresh attempt on the same untouched task a NEW state and buy an unbounded
 * chain of continuations, one per crashed session — the exact loop R-32 forbids.
 * The stalled state is (which task, in what status, stuck how); which session
 * happened to be holding it is evidence, and evidence goes in the body.
 */
export function stallFingerprint(input: {
  taskId: string;
  taskStatus: string;
  reason: StallReason;
}): string {
  const digest = createHash('sha256')
    .update([input.taskId, input.taskStatus, input.reason].join('\0'), 'utf8')
    .digest('hex');
  return `${STALL_FINGERPRINT_PREFIX}:${digest.slice(0, 32)}`;
}

export function isStallFingerprint(value: string | null): boolean {
  return value?.startsWith(`${STALL_FINGERPRINT_PREFIX}:`) ?? false;
}

/**
 * What recovery does next for a stalled state, given the continuation row that
 * fingerprint already produced (or null if it produced none).
 *
 * Three steps, then silence. The escalation is detected by ownership rather than
 * a flag column: a continuation starts owned by the SAME agent as the stalled
 * task (R-32's "MUST preserve ownership" — never a different agent), and
 * escalation is the single transition to a human assignee. R-14 makes those two
 * mutually exclusive, so `assigneeUserId !== null` is an exact, unforgeable
 * "this has already been escalated".
 */
export type RecoveryStep = 'continued' | 'escalated' | 'already_escalated';

export function nextRecoveryStep(
  existing: Pick<AgiTaskRow, 'assigneeUserId'> | null,
): RecoveryStep {
  if (!existing) return 'continued';
  return existing.assigneeUserId === null ? 'escalated' : 'already_escalated';
}

/**
 * Which stalls recovery may act on at all.
 *
 * Being stalled is not the same as needing a continuation. An agent-owned task
 * sitting in `backlog` with no goal and no trigger is stalled by R-28 — nothing
 * is scheduled to look at it — but it is stalled because a HUMAN has not
 * scheduled it, and manufacturing work for it would bury the real signal under
 * one continuation per untended row.
 *
 * The stalls worth continuing are the ones where work was picked up and dropped:
 * a claim exists or existed. That is the crash signature this module was built
 * for, and it is the only case where "someone was on this and now nobody is" is
 * true. Everything else is surfaced by {@link resolveTaskLiveness} and left for a
 * human or the next `push` to judge — R-29 asks for it to be surfaced, not
 * retried.
 *
 * `hasRecovery` is what keeps the three-step bound reachable. Releasing a dead
 * lease is the first thing recovery does, and that erases `claim_session_id` —
 * so on the NEXT observation the claim lineage is gone and this predicate would
 * refuse to escalate the very stall it just continued. An existing recovery row
 * is durable proof the stall was recoverable once, and nothing but recovery can
 * create one, so admitting it cannot let an untended backlog task in.
 */
export function isRecoverableStall(input: {
  reason: StallReason | null;
  hadClaim: boolean;
  hasRecovery: boolean;
}): boolean {
  if (input.reason === null) return false;
  // R-12g stalls are never continued. The fix for an ask that reached nobody is
  // to DELIVER it — manufacturing a continuation task would add a second row
  // nobody was told about, and escalating it to a human assignee would quietly
  // convert "we could not reach anyone" into "someone owns this", which is the
  // false-healthy answer the whole section exists to prevent. It is surfaced and
  // left surfaced (R-29: surfaced, not retried).
  //
  // `request_unanswered` is excluded for the same reason and one more. The thing
  // that would unstick the work is a specific human act — a grant, a key, a
  // decision — and no task this system manufactures can perform it. A
  // continuation would be a row asking an agent to wait harder, and the
  // escalation after it would hand the account owner a task whose entire content
  // is "somebody did not answer a question", competing for attention with the
  // ask itself. The ask is already addressed to a person and already on the stall
  // surface; the honest act is to leave it there and say how long it has waited.
  if (input.reason === 'request_undelivered' || input.reason === 'request_unanswered') {
    return false;
  }
  // `blocked_without_cause` deliberately stays recoverable. It is a stall on
  // work that WAS picked up and dropped, which is exactly what R-32's bound
  // exists for: one continuation, and if the same evidence comes back, an
  // escalation to a human. That escalation is itself a way of reaching one —
  // weaker than an addressed ask, which is why the prompt tells the agent to
  // raise a request instead of letting recovery discover the block for it.
  return input.hadClaim || input.hasRecovery;
}

export const CONTINUATION_TITLE_PREFIX = 'Stalled:';
export const ESCALATION_TITLE_PREFIX = 'Escalated:';

/** Titles are derived, not free text, so a repeat sweep produces a byte-identical
 *  row and a human scanning `kortix tasks ls` sees one entry per stalled state. */
export function continuationTitle(taskTitle: string, escalated = false): string {
  const prefix = escalated ? ESCALATION_TITLE_PREFIX : CONTINUATION_TITLE_PREFIX;
  const body = `${prefix} ${taskTitle}`;
  return body.length > 500 ? `${body.slice(0, 497)}...` : body;
}

/**
 * The cause-and-evidence R-32 requires an escalation to carry. Written once, at
 * continuation time, and left alone afterwards — the escalation edits ownership,
 * never the evidence, so the human sees what the machine saw.
 */
export function continuationBody(input: {
  taskId: string;
  reason: StallReason;
  evidence: ProgressEvidence;
  sessionId: string | null;
  observedAt: Date;
}): string {
  return [
    `Task ${input.taskId} made no progress and has no live path (R-28/R-33).`,
    '',
    `reason: ${input.reason}`,
    `evidence: ${input.evidence}`,
    `last claim session: ${input.sessionId ?? 'none'}`,
    `observed at: ${input.observedAt.toISOString()}`,
    '',
    'This is one automatic continuation (R-32). If the same stalled state is',
    'observed again it is escalated to a human instead of continued, and no',
    'further continuation is ever created for it.',
  ].join('\n');
}

// ─── R-28/R-29: what moves this forward next? ───────────────────────────────

export interface TaskLivenessInput {
  task: AgiTaskRow;
  now: Date;
  /** State of the session named by `claim_session_id`. */
  claimSession: ClaimSessionState;
  /** Rows for the ids in `blocked_by` that still resolve, any order. */
  blockers: readonly Pick<AgiTaskRow, 'taskId' | 'status'>[];
  /** The fingerprinted recovery row this task already produced, if any. */
  recovery: Pick<AgiTaskRow, 'taskId' | 'assigneeUserId' | 'agent'> | null;
  /** The oldest PENDING human request on this task (spec §4.3), or null. Only
   *  pending rows are passed: a satisfied ask must stop propping the task up the
   *  instant it is answered. */
  request: PendingRequestRef | null;
  /** How long a delivered ask keeps counting as a live path, in ms. Defaults to
   *  the configured window so a caller that has not thought about it gets the
   *  same answer the read surface gives; pass it explicitly to judge a whole
   *  workspace with one threshold (and to test it without touching env). */
  requestUnansweredAfterMs?: number;
}

/**
 * What liveness needs to know about a pending human request, and nothing more.
 *
 * `delivered` arrives as a decided boolean because requests/wire.ts owns R-12g's
 * line (`isDelivered` there) and there must be exactly one place that decides
 * whether an ask reached a human. Two implementations of it would eventually
 * disagree, and the direction they would disagree in is "reads healthy, nobody
 * was told".
 *
 * The AGE is not pre-decided the same way, and deliberately so: it depends on
 * `now`, and this module's whole contract is that `now` comes from the caller.
 * The timestamp travels; the comparison happens once, below, against the same
 * instant every other branch is judged with.
 */
export interface PendingRequestRef {
  requestId: string;
  kind: string;
  need: string;
  responderUserId: string | null;
  /** R-12g's line: the ask reached a surface a human sees. This is the DELIVERY
   *  fact alone — whether anybody acted on it is the separate question
   *  `deliveredAt` answers. */
  delivered: boolean;
  deliveredVia: string | null;
  /** WHEN it reached them, so the verdict can say how long it has gone
   *  unanswered. Optional because a caller that only knows the boolean is still
   *  a legitimate caller (the session-terminal writeback is one); an absent
   *  timestamp means the age is unknown and no ask is aged out on a fact nobody
   *  has. */
  deliveredAt?: Date | null;
}

export interface TaskLiveness {
  state: LivenessState;
  reason: StallReason | null;
  claimSession: ClaimSessionState | null;
  /** Unresolved `blocked_by` ids — missing, or resolving to a task that is not
   *  `done`. R-17 keeps cancelled blockers in here. */
  unresolvedBlockers: string[];
  recovery: {
    taskId: string;
    escalated: boolean;
    escalatedTo: string | null;
  } | null;
  /** Attached whenever one exists, in EVERY state — including the states it did
   *  not decide. A human reading "why is this stuck" needs the ask and its link
   *  in front of them, not a request id to go look up. */
  request: PendingRequestRef | null;
  /** The window this verdict was reached with, echoed exactly like
   *  `flatStallAfter` on the goal side so a caller never has to guess which
   *  threshold produced `request_unanswered` — or why an ask this old has not
   *  produced it yet. */
  requestUnansweredAfterMs: number;
  /** How long the attached ask has gone unanswered, in ms, or null when there is
   *  no ask, it was never delivered, or the caller supplied no timestamp. This is
   *  the number the stall report reads out loud: "nobody has answered X for X
   *  days" is the sentence, and a reason string alone cannot say it. */
  requestUnansweredForMs: number | null;
}

/**
 * R-28, evaluated in the order the spec lists its answers, with one deviation
 * that is the whole point of the module: a claim that has not expired proves
 * answer 1 ONLY if the claiming session is not already terminal. A dead session's
 * unexpired lease is the single most convincing-looking non-path there is —
 * every read shows `claimed: true` — and it is exactly what an overnight crash
 * leaves behind.
 *
 * Note what is NOT consulted: sandbox state, process liveness, log contents. R-30
 * rules all of them out as evidence, so reading them could only produce a wrong
 * `working`.
 */
export function resolveTaskLiveness(input: TaskLivenessInput): TaskLiveness {
  const { task, now } = input;
  const recovery = input.recovery
    ? {
        taskId: input.recovery.taskId,
        escalated: input.recovery.assigneeUserId !== null,
        escalatedTo: input.recovery.assigneeUserId,
      }
    : null;

  const unansweredAfterMs = input.requestUnansweredAfterMs ?? resolveRequestUnansweredAfterMs();
  const unansweredForMs = input.request?.delivered
    ? requestUnansweredForMs({ deliveredAt: input.request.deliveredAt, now })
    : null;

  const base = {
    reason: null as StallReason | null,
    claimSession: null as ClaimSessionState | null,
    unresolvedBlockers: [] as string[],
    recovery,
    request: input.request,
    requestUnansweredAfterMs: unansweredAfterMs,
    requestUnansweredForMs: unansweredForMs,
  };

  // R-12g's line plus its missing half, decided once. A pending ask is a live
  // path (R-28 answer 5) only while BOTH are true: it reached a surface a human
  // sees, and that human still plausibly means to answer it. An ask delivered
  // and ignored for two days is not a person about to act; it is a fact about
  // something that happened once, which R-30 is explicit does not move work.
  const requestOverdue =
    input.request?.delivered === true &&
    isRequestAnswerOverdue({
      deliveredAt: input.request.deliveredAt,
      now,
      unansweredAfterMs,
    });
  const requestIsLivePath = input.request?.delivered === true && !requestOverdue;

  if (isTerminalTaskStatus(task.status)) return { ...base, state: 'settled' };

  const claimLive =
    task.claimSessionId !== null &&
    task.claimExpiresAt !== null &&
    task.claimExpiresAt.getTime() > now.getTime();

  if (claimLive) {
    if (input.claimSession === 'terminal') {
      return {
        ...base,
        state: 'stalled',
        reason: 'claiming_session_terminal',
        claimSession: 'terminal',
      };
    }
    return { ...base, state: 'working', claimSession: input.claimSession };
  }

  // An expired claim is not a live path (R-19 makes it adoptable, R-30 forbids
  // treating "someone once started" as progress), so everything below decides
  // the task's fate as if it were unclaimed.
  const byId = new Map(input.blockers.map((row) => [row.taskId, row]));
  const unresolved: string[] = [];
  let hasHealthyBlocker = false;
  for (const id of task.blockedBy) {
    const row = byId.get(id);
    if (row?.status === 'done') continue;
    unresolved.push(id);
    // A blocker that is itself open is R-28 answer 3's "healthy". Depth is
    // deliberately one: a blocker that is itself stalled surfaces on its OWN
    // row, and walking the graph here would report the same stall N times.
    if (row && !isTerminalTaskStatus(row.status)) hasHealthyBlocker = true;
  }

  if (unresolved.length > 0) {
    if (hasHealthyBlocker) {
      return { ...base, state: 'blocked', unresolvedBlockers: unresolved };
    }
    // A delivered ask rescues a dead-blocker stall: the blockers are indeed all
    // dead, but a named human has been asked for the thing that would unstick
    // this, and that is R-28 answer 5. Nothing here prunes the edges — they stay
    // in `unresolvedBlockers` so the report keeps both facts.
    if (requestIsLivePath) {
      return { ...base, state: 'awaiting_response', unresolvedBlockers: unresolved };
    }
    return {
      ...base,
      state: 'stalled',
      reason: 'dead_blocker',
      unresolvedBlockers: unresolved,
    };
  }

  if (task.assigneeUserId !== null) return { ...base, state: 'human' };

  // R-28 answer 5, and the reason §4.3 exists.
  //
  // This is evaluated BEFORE the trigger check, which is the one deliberate
  // departure from R-28's listed order and the whole value of the feature. A
  // goal-linked task blocked on a missing credential would otherwise read as
  // `awaiting_trigger` — perfectly healthy — forever, because it does have a
  // standing `push` and that push does fire. It just cannot advance: every fire
  // re-derives the same block and hits the same wall. A future fire is only a
  // live path if it can move the work, so a pending ask decides this task's
  // verdict and the trigger does not get to overrule it.
  if (input.request) {
    if (requestIsLivePath) return { ...base, state: 'awaiting_response' };
    return {
      ...base,
      state: 'stalled',
      // Which failure it is matters more than that it is one: `undelivered` is
      // fixed by sending the ask, `unanswered` by answering it. Reporting either
      // as the other sends a human to the wrong place.
      reason: requestOverdue ? 'request_unanswered' : 'request_undelivered',
    };
  }

  // R-12g, the reachable half. Everything above has been ruled out: no live
  // claim, no unresolved edge, no human assignee, no pending ask. A task still
  // sitting in `blocked` is therefore waiting on something it never told the
  // system about — and R-31 says prose is not a control-plane act, so whatever
  // it wrote in its body or its session log does not count.
  //
  // Deliberately BEFORE the trigger check, for the same reason the ask is: a
  // standing `push` will fire, re-derive the identical block, and stop again. A
  // future fire is a live path only if it can move the work.
  //
  // This state is already anomalous by construction — both `tasks block` and
  // `resolveCompletedBlocker` move a task out of `blocked` the moment its last
  // edge clears — so nothing that manages its dependencies properly lands here.
  // The fix is to state the dependency (`kortix tasks block --on`) or to ask the
  // human (`kortix tasks request`), never to leave the reason in prose.
  if (task.status === 'blocked') {
    return { ...base, state: 'stalled', reason: 'blocked_without_cause' };
  }

  // Work that was PICKED UP AND DROPPED, evaluated before answer 2 — the second
  // deliberate departure from R-28's listed order, and the one that made the
  // difference between a stall surface and a board that reports zero.
  //
  // Answer 2 is "a future trigger fire that will pick it up". That sentence is
  // true of a task nobody has started: the fire finds it in `todo`, claims it,
  // and work begins. It is NOT true of a task somebody already started and
  // abandoned. Two rows say so, and neither is prose:
  //
  //   • `claim_session_id` still names a session whose lease has lapsed —
  //     somebody took this and did not put it down;
  //   • `status: doing` with no claimant at all — the row asserts a session is
  //     on it in the present tense and no session is.
  //
  // The second case is the one the sweep itself creates. Releasing a dead lease
  // is the right first fix, but it ERASES the claim, so before this branch
  // existed the very next verdict on that same row was `awaiting_trigger` and
  // bounded recovery (R-32) was skipped for a task left mid-flight with nobody
  // on it and no recovery row. Since the AGI's prompt tells it to create every
  // task with `--goal`, that made R-32 structurally unreachable for the entire
  // board.
  //
  // What a future fire actually does with such a row is re-derive the same
  // half-finished state and stop — the identical argument the ask and the prose
  // block above are decided on. A trigger is a live path only if it can move the
  // work.
  const claimLapsed = task.claimSessionId !== null;
  if (claimLapsed || isInFlightTaskStatus(task.status)) {
    return {
      ...base,
      state: 'stalled',
      // The lapsed lease is the more specific evidence — it names WHO dropped
      // this — so it wins when both are true.
      reason: claimLapsed ? 'claim_expired' : 'abandoned_in_flight',
      claimSession: claimLapsed ? input.claimSession : null,
    };
  }

  // R-28 answer 2. `trigger_slug` is the task's own recurrence lineage (R-22) and
  // `goal_slug` implies the goal's standing `push` (R-8, R-11) — both are a
  // future fire of the ONE trigger subsystem. We do not re-read kortix.yaml to
  // confirm the trigger still exists; a manifest that deleted the trigger is a
  // manifest-validation concern, not something to re-derive on every read.
  if (task.triggerSlug !== null || task.goalSlug !== null) {
    return { ...base, state: 'awaiting_trigger' };
  }

  // Nothing took it, nothing is scheduled to. `claim_session_id` is necessarily
  // null here — the branch above owns every row that carries one.
  return { ...base, state: 'stalled', reason: 'no_live_path' };
}

// ─── R-12d/R-12e: is the GOAL moving? ───────────────────────────────────────
//
// A task's liveness answers "what moves this forward next?". A goal's answers a
// different question — "did it get closer?" — and only a metric can answer it.
// The two live in the same module, and are surfaced by the same route, because
// R-12e says a flat line MUST surface as a stall "exactly like a task with no
// live path": one place a human looks to find out what is stuck. They are not
// merged into one vocabulary, because a goal is not a task and pretending
// otherwise would give a goal a claim, a blocker list, and a recovery row it
// cannot have.

/**
 * The answer to "is this goal moving?".
 *
 *   settled       — achieved or abandoned. Outside the question, like a terminal
 *                   task's `settled`.
 *   paused        — deliberately not advancing. Not a defect.
 *   measuring     — active, at least one metric, and something has moved (or is
 *                   too new to have gone flat).
 *   unmeasurable  — R-12d. `done_when` names a threshold and NOTHING has ever
 *                   been recorded. Distinct from `stalled` on purpose: the fix
 *                   is to start measuring, not to work harder.
 *   unquantified  — active, nothing recorded, and `done_when` names no threshold
 *                   to record. Legal under R-7, reported so it is a choice
 *                   rather than an oversight.
 *   stalled       — R-12e. The metric that defines the goal has been flat across
 *                   at least N consecutive readings. Which metric that is, and
 *                   therefore which rule applied, is on the verdict — see
 *                   {@link resolveGoalStall}.
 */
export const GOAL_LIVENESS_STATES = [
  'settled',
  'paused',
  'measuring',
  'unmeasurable',
  'unquantified',
  'stalled',
] as const;
export type GoalLivenessState = (typeof GOAL_LIVENESS_STATES)[number];

/** Why a goal is stalled. One value today; it is an array because §13 leaves
 *  open what else counts, and a bare boolean could not grow. */
export const GOAL_STALL_REASONS = ['metric_flat'] as const;
export type GoalStallReason = (typeof GOAL_STALL_REASONS)[number];

export interface GoalLiveness {
  state: GoalLivenessState;
  reason: GoalStallReason | null;
  /** Metrics whose flat run has reached the threshold, worst (longest flat run)
   *  first — the ones a human should be told about by name. */
  flatMetrics: { metric: string; flatObservations: number }[];
  /** The threshold this verdict was reached with, so a caller never has to guess
   *  which N produced it. */
  flatStallAfter: number;
  /** Which rule decided this — `primary` when the goal declares `metric:`,
   *  `any_metric` when it does not. Two rules that disagree on purpose, so a
   *  reader who cannot tell them apart cannot read the verdict. */
  rule: GoalStallRule;
  /** The metric whose flat run produced `stalled`, or null. `flatMetrics` lists
   *  everything that is flat; this names the one that was the VERDICT. */
  drivenBy: string | null;
  /** The goal's declared primary metric, or null. Echoed so `unmeasurable` on a
   *  goal that has other series is self-explaining: this is the one missing. */
  primaryMetric: string | null;
}

export interface GoalLivenessInput {
  status: string;
  doneWhen: string;
  metrics: readonly GoalMetricSummary[];
  flatStallAfter: number;
  /** The goal's `metric:` declaration, already normalized by the manifest parser.
   *  Optional so an existing caller keeps the `any_metric` rule. */
  primaryMetric?: string | null;
}

/**
 * R-12e, decided from the series alone. The RULE lives in
 * {@link resolveGoalStall} (../observations/wire.ts), next to the series it
 * reasons about; this function is the state machine around it — status first,
 * then measurability, then movement.
 *
 * The ordering is the whole contract:
 *
 *   • terminal and paused statuses are outside the question entirely.
 *   • `unmeasurable` is checked BEFORE the flat run and can never be reached by
 *     it. With no reading for the metric that matters there is no run to be
 *     flat, and R-12d insists that case is its own thing rather than folded into
 *     "on track" OR into "stalled". A goal that DECLARES its metric and has
 *     never recorded it lands here even when other series exist — nobody is
 *     measuring the thing the goal is about, and three healthy-looking unrelated
 *     series make that worse, not better.
 *   • only then does flatness decide, and it decides by exactly one metric under
 *     `primary` or by any metric under `any_metric`.
 */
export function resolveGoalLiveness(input: GoalLivenessInput): GoalLiveness {
  const stall = resolveGoalStall({
    metrics: input.metrics,
    primaryMetric: input.primaryMetric ?? null,
    flatStallAfter: input.flatStallAfter,
  });

  const base = {
    reason: null as GoalStallReason | null,
    flatMetrics: [] as { metric: string; flatObservations: number }[],
    flatStallAfter: input.flatStallAfter,
    rule: stall.rule,
    drivenBy: null as string | null,
    primaryMetric: stall.primaryMetric,
  };

  if (input.status === 'achieved' || input.status === 'abandoned') {
    return { ...base, state: 'settled' };
  }
  if (input.status === 'paused') return { ...base, state: 'paused' };

  // R-12d, per-metric. Deliberately ahead of the empty-metrics check so the two
  // roads to "un-judged" produce the same word.
  if (stall.primaryUnobserved) {
    return { ...base, state: 'unmeasurable', flatMetrics: stall.flatMetrics };
  }

  if (input.metrics.length === 0) {
    return {
      ...base,
      state: namesThreshold(input.doneWhen) ? 'unmeasurable' : 'unquantified',
    };
  }

  if (stall.stalled) {
    return {
      ...base,
      state: 'stalled',
      reason: 'metric_flat',
      flatMetrics: stall.flatMetrics,
      drivenBy: stall.drivenBy,
    };
  }
  // Flat metrics are still reported by name on a `measuring` goal: under
  // `primary` a flat secondary never condemns anything, and it must still be
  // visible rather than invisible.
  return { ...base, state: 'measuring', flatMetrics: stall.flatMetrics };
}

export function serializeGoalLiveness(liveness: GoalLiveness) {
  return {
    state: liveness.state,
    reason: liveness.reason,
    flat_metrics: liveness.flatMetrics.map((entry) => ({
      metric: entry.metric,
      flat_observations: entry.flatObservations,
    })),
    flat_stall_after: liveness.flatStallAfter,
    /** R-12e: which of the two rules produced `state`, and which metric was the
     *  verdict. Without both, "measuring" is ambiguous between "the number that
     *  matters moved" and "some number moved". */
    stall_rule: liveness.rule,
    driven_by: liveness.drivenBy,
    primary_metric: liveness.primaryMetric,
  };
}

export type SerializedGoalLiveness = ReturnType<typeof serializeGoalLiveness>;

export function serializeTaskLiveness(liveness: TaskLiveness) {
  return {
    state: liveness.state,
    reason: liveness.reason,
    claim_session_state: liveness.claimSession,
    unresolved_blockers: liveness.unresolvedBlockers,
    recovery: liveness.recovery
      ? {
          task_id: liveness.recovery.taskId,
          escalated: liveness.recovery.escalated,
          escalated_to: liveness.recovery.escalatedTo,
        }
      : null,
    // R-12g, on the wire. `delivered` is the field a human scanning a stall
    // report actually needs: false means the ask exists and nobody was told.
    // `delivered_at` is the other half — true with a date two months back means
    // somebody WAS told and nothing happened.
    request: liveness.request
      ? {
          request_id: liveness.request.requestId,
          kind: liveness.request.kind,
          need: liveness.request.need,
          responder_user_id: liveness.request.responderUserId,
          delivered: liveness.request.delivered,
          delivered_via: liveness.request.deliveredVia,
          delivered_at: liveness.request.deliveredAt?.toISOString() ?? null,
        }
      : null,
    // Echoed on every verdict, like `flat_stall_after` on the goal side: the
    // threshold that produced the answer, and the age it was compared against.
    request_unanswered_after_ms: liveness.requestUnansweredAfterMs,
    request_unanswered_for_ms: liveness.requestUnansweredForMs,
  };
}

export type SerializedTaskLiveness = ReturnType<typeof serializeTaskLiveness>;
