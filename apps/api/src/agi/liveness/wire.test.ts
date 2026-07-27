import { describe, expect, test } from 'bun:test';
// Import order is load-bearing, and not for this module's sake. `../tasks/wire`
// reaches `projects/lib/serializers` for one regex, that file reaches
// `projects/lib/sessions`, and that file imports the liveness barrel for the
// session-terminal hook — a cycle that already exists on main. Entering it at
// any leaf (this file's `./wire`, or `../tasks/wire` directly, which is why
// tasks/wire.test.ts fails the same way) makes a store module read a status
// vocabulary mid-initialization and throw before a single test runs. Entering at
// the barrel initializes the ring in an order where every top-level const is
// ready. Delete this line and the whole file dies with a ReferenceError.
import './index';
import {
  CONTINUATION_TITLE_PREFIX,
  ESCALATION_TITLE_PREFIX,
  classifyClaimProgress,
  classifyClaimSession,
  continuationBody,
  continuationTitle,
  isRecoverableStall,
  isStallFingerprint,
  nextRecoveryStep,
  resolveGoalLiveness,
  resolveTaskLiveness,
  serializeGoalLiveness,
  serializeTaskLiveness,
  stallFingerprint,
  type PendingRequestRef,
} from './wire';
import { summarizeMetric, type GoalMetricSummary } from '../observations/wire';
import type { AgiTaskRow } from '../tasks/wire';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const BLOCKER_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_BLOCKER_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-07-27T12:00:00.000Z');

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Pinned in the fixtures rather than read from env, so these tests judge the
 *  ordering and never the deployment's configuration. */
const UNANSWERED_AFTER = 48 * HOUR;

function row(overrides: Partial<AgiTaskRow> = {}): AgiTaskRow {
  return {
    taskId: TASK_ID,
    workspaceId: '55555555-5555-4555-8555-555555555555',
    parentId: null,
    goalSlug: null,
    project: null,
    title: 'Ship it',
    body: null,
    status: 'doing',
    priority: 'medium',
    agent: 'researcher',
    assigneeUserId: null,
    blockedBy: [],
    triggerSlug: null,
    claimSessionId: null,
    claimedAt: null,
    claimExpiresAt: null,
    origin: 'session',
    originFingerprint: null,
    createdAt: new Date('2026-07-27T10:00:00.000Z'),
    updatedAt: new Date('2026-07-27T10:00:00.000Z'),
    ...overrides,
  } as AgiTaskRow;
}

/** A claim that has NOT expired at NOW. */
function liveClaim(overrides: Partial<AgiTaskRow> = {}): AgiTaskRow {
  return row({
    claimSessionId: 'ses_live',
    claimedAt: new Date('2026-07-27T11:55:00.000Z'),
    claimExpiresAt: new Date('2026-07-27T12:10:00.000Z'),
    updatedAt: new Date('2026-07-27T11:55:00.000Z'),
    ...overrides,
  });
}

function blocker(taskId: string, status: string) {
  return { taskId, status } as Pick<AgiTaskRow, 'taskId' | 'status'>;
}

function liveness(task: AgiTaskRow, extra: Partial<Parameters<typeof resolveTaskLiveness>[0]> = {}) {
  return resolveTaskLiveness({
    task,
    now: NOW,
    claimSession: 'unknown',
    blockers: [],
    recovery: null,
    request: null,
    requestUnansweredAfterMs: UNANSWERED_AFTER,
    ...extra,
  });
}

/** A pending human request (spec §4.3). `delivered` defaults to true and the
 *  delivery is RECENT — the ordinary case is an ask that reached somebody and
 *  might still be answered. The two failures, an ask that reached nobody and one
 *  nobody answered, are the point of the feature and every test that wants one
 *  says so explicitly. */
function request(overrides: Partial<PendingRequestRef> = {}): PendingRequestRef {
  return {
    requestId: '66666666-6666-4666-8666-666666666666',
    kind: 'secret',
    need: 'GOOGLE_SEARCH_CONSOLE_TOKEN',
    responderUserId: USER_ID,
    delivered: true,
    deliveredVia: 'slack',
    deliveredAt: new Date(NOW.getTime() - HOUR),
    ...overrides,
  };
}

/** An ask that reached a named human `agoMs` ago and has not been answered. */
function delivered(agoMs: number, overrides: Partial<PendingRequestRef> = {}): PendingRequestRef {
  return request({ deliveredAt: new Date(NOW.getTime() - agoMs), ...overrides });
}

/** A claim whose TTL has already passed at NOW. The row still names the session
 *  that took it — which is exactly the evidence the ordering fix turns on. */
function expiredClaim(overrides: Partial<AgiTaskRow> = {}): AgiTaskRow {
  return row({
    status: 'doing',
    claimSessionId: 'ses_dead',
    claimedAt: new Date('2026-07-27T10:00:00.000Z'),
    claimExpiresAt: new Date('2026-07-27T10:15:00.000Z'),
    ...overrides,
  });
}

describe('classifyClaimSession', () => {
  test.each([
    ['stopped', 'terminal'],
    ['completed', 'terminal'],
    ['failed', 'terminal'],
    ['running', 'active'],
    ['queued', 'active'],
  ])('%s is %s', (status, expected) => {
    expect(classifyClaimSession(status)).toBe(expected as never);
  });

  test('an unresolvable claim id is unknown, never terminal (R-19)', () => {
    expect(classifyClaimSession(null)).toBe('unknown');
    expect(classifyClaimSession(undefined)).toBe('unknown');
  });
});

describe('classifyClaimProgress (R-33)', () => {
  test('a claim nothing touched since it landed is no progress', () => {
    const progress = classifyClaimProgress({
      task: { status: 'doing' },
      writtenSinceClaim: false,
      childrenCreatedAfterClaim: 0,
    });
    expect(progress).toEqual({ progressed: false, evidence: 'untouched_since_claim' });
  });

  test('a write after the claim is progress — a recorded reason counts (R-12)', () => {
    const progress = classifyClaimProgress({
      task: { status: 'blocked' },
      writtenSinceClaim: true,
      childrenCreatedAfterClaim: 0,
    });
    expect(progress).toEqual({ progressed: true, evidence: 'task_written' });
  });

  test('a terminal status is progress even with no write since the claim', () => {
    expect(
      classifyClaimProgress({
        task: { status: 'done' },
        writtenSinceClaim: false,
        childrenCreatedAfterClaim: 0,
      }),
    ).toEqual({ progressed: true, evidence: 'task_terminal' });
  });

  test('creating work underneath the task is progress even when the row is untouched', () => {
    expect(
      classifyClaimProgress({
        task: { status: 'doing' },
        writtenSinceClaim: false,
        childrenCreatedAfterClaim: 2,
      }),
    ).toEqual({ progressed: true, evidence: 'children_created' });
  });
});

describe('stallFingerprint (R-32)', () => {
  test('identical evidence produces an identical fingerprint', () => {
    const a = stallFingerprint({ taskId: TASK_ID, taskStatus: 'doing', reason: 'no_live_path' });
    const b = stallFingerprint({ taskId: TASK_ID, taskStatus: 'doing', reason: 'no_live_path' });
    expect(a).toBe(b);
    expect(isStallFingerprint(a)).toBe(true);
  });

  test('the session id is not an input — a second crashed session is the SAME stalled state', () => {
    // The whole bound depends on this: were the session part of the key, every
    // fresh crash would mint a new fingerprint and buy another continuation.
    const one = stallFingerprint({ taskId: TASK_ID, taskStatus: 'doing', reason: 'claim_expired' });
    const two = stallFingerprint({ taskId: TASK_ID, taskStatus: 'doing', reason: 'claim_expired' });
    expect(one).toBe(two);
  });

  test('a different status or reason is a different stalled state', () => {
    const base = stallFingerprint({ taskId: TASK_ID, taskStatus: 'doing', reason: 'no_live_path' });
    expect(stallFingerprint({ taskId: TASK_ID, taskStatus: 'todo', reason: 'no_live_path' })).not.toBe(base);
    expect(stallFingerprint({ taskId: TASK_ID, taskStatus: 'doing', reason: 'dead_blocker' })).not.toBe(base);
    expect(stallFingerprint({ taskId: BLOCKER_ID, taskStatus: 'doing', reason: 'no_live_path' })).not.toBe(base);
  });

  test('the field separator cannot be forged from the parts', () => {
    // Without a separator, ("ab","c") and ("a","bc") would collide.
    expect(stallFingerprint({ taskId: 'ab', taskStatus: 'c', reason: 'no_live_path' })).not.toBe(
      stallFingerprint({ taskId: 'a', taskStatus: 'bc', reason: 'no_live_path' }),
    );
  });

  test('only fingerprints this module minted are recognised', () => {
    expect(isStallFingerprint(null)).toBe(false);
    expect(isStallFingerprint('trigger:daily:2026-07-27')).toBe(false);
  });
});

describe('nextRecoveryStep (R-32)', () => {
  test('no continuation yet means continue', () => {
    expect(nextRecoveryStep(null)).toBe('continued');
  });

  test('an agent-owned continuation means the same state recurred — escalate', () => {
    expect(nextRecoveryStep({ assigneeUserId: null })).toBe('escalated');
  });

  test('a human-owned continuation is the end of the line', () => {
    expect(nextRecoveryStep({ assigneeUserId: USER_ID })).toBe('already_escalated');
  });
});

describe('isRecoverableStall', () => {
  test('a stall on work that was picked up and dropped is recoverable', () => {
    expect(
      isRecoverableStall({ reason: 'claim_expired', hadClaim: true, hasRecovery: false }),
    ).toBe(true);
    expect(
      isRecoverableStall({ reason: 'claiming_session_terminal', hadClaim: true, hasRecovery: false }),
    ).toBe(true);
  });

  test('a task nobody ever claimed is surfaced, never continued', () => {
    // Otherwise every untended backlog row in the workspace would grow a
    // continuation child on the first sweep and bury the real signal.
    expect(
      isRecoverableStall({ reason: 'no_live_path', hadClaim: false, hasRecovery: false }),
    ).toBe(false);
    expect(
      isRecoverableStall({ reason: 'dead_blocker', hadClaim: false, hasRecovery: false }),
    ).toBe(false);
  });

  test('an existing recovery row keeps escalation reachable after the lease was cleared', () => {
    // Recovery releases the dead lease first, so `hadClaim` is false by the time
    // the SAME stall is observed again — without this the bound would stop at
    // step one and nothing would ever reach a human.
    expect(
      isRecoverableStall({ reason: 'no_live_path', hadClaim: false, hasRecovery: true }),
    ).toBe(true);
  });

  test('a task that is not stalled at all is never recovered', () => {
    expect(isRecoverableStall({ reason: null, hadClaim: true, hasRecovery: true })).toBe(false);
  });

  test('R-12g: an undelivered ask is surfaced and NEVER continued, claim or no claim', () => {
    // The fix for an ask that reached nobody is to deliver it. A continuation
    // would add a row nobody was told about, and its escalation would quietly
    // convert "we could not reach anyone" into "someone owns this" — the exact
    // false-healthy answer §4.3 exists to prevent.
    expect(
      isRecoverableStall({ reason: 'request_undelivered', hadClaim: true, hasRecovery: false }),
    ).toBe(false);
    expect(
      isRecoverableStall({ reason: 'request_undelivered', hadClaim: true, hasRecovery: true }),
    ).toBe(false);
  });

  test('a block stated only in prose IS recoverable — it is work picked up and dropped', () => {
    // The distinction from `request_undelivered`: there, an addressed ask
    // already exists and a continuation would double-report it. Here nobody has
    // been told anything, so R-32's one continuation and then escalation to a
    // human is the right bound.
    expect(
      isRecoverableStall({ reason: 'blocked_without_cause', hadClaim: true, hasRecovery: false }),
    ).toBe(true);
    expect(
      isRecoverableStall({ reason: 'blocked_without_cause', hadClaim: false, hasRecovery: false }),
    ).toBe(false);
  });
});

describe('resolveTaskLiveness — R-28 answers', () => {
  test('a terminal task is settled, not judged', () => {
    expect(liveness(row({ status: 'done' })).state).toBe('settled');
    expect(liveness(row({ status: 'cancelled' })).state).toBe('settled');
  });

  test('answer 1: an unexpired claim held by a live session is working', () => {
    expect(liveness(liveClaim(), { claimSession: 'active' }).state).toBe('working');
  });

  test('an unexpired claim whose id does not resolve stays working until the TTL (R-19)', () => {
    // Breaking a claim we merely cannot see would be exactly the thing R-19
    // forbids; expiry is the only lever.
    expect(liveness(liveClaim(), { claimSession: 'unknown' }).state).toBe('working');
  });

  test('an unexpired claim held by a TERMINAL session is the overnight stall', () => {
    const result = liveness(liveClaim(), { claimSession: 'terminal' });
    expect(result.state).toBe('stalled');
    expect(result.reason).toBe('claiming_session_terminal');
    expect(result.claimSession).toBe('terminal');
  });

  test('answer 3: an unresolved edge to an open blocker is blocked', () => {
    const result = liveness(row({ blockedBy: [BLOCKER_ID] }), {
      blockers: [blocker(BLOCKER_ID, 'doing')],
    });
    expect(result.state).toBe('blocked');
    expect(result.unresolvedBlockers).toEqual([BLOCKER_ID]);
  });

  test('a done blocker resolves its edge and stops blocking', () => {
    // `todo`, not the fixture's `doing`: this is about the EDGE, and a task that
    // says a session is on it right now with no claimant has its own verdict.
    const result = liveness(row({ status: 'todo', blockedBy: [BLOCKER_ID], goalSlug: 'oil-desk' }), {
      blockers: [blocker(BLOCKER_ID, 'done')],
    });
    expect(result.state).toBe('awaiting_trigger');
    expect(result.unresolvedBlockers).toEqual([]);
  });

  test('R-17: a cancelled blocker does NOT satisfy the edge, and waiting on it is a stall', () => {
    const result = liveness(row({ blockedBy: [BLOCKER_ID] }), {
      blockers: [blocker(BLOCKER_ID, 'cancelled')],
    });
    expect(result.state).toBe('stalled');
    expect(result.reason).toBe('dead_blocker');
    expect(result.unresolvedBlockers).toEqual([BLOCKER_ID]);
  });

  test('a blocker id that no longer resolves is unresolved, never pruned (R-17)', () => {
    const result = liveness(row({ blockedBy: [BLOCKER_ID] }), { blockers: [] });
    expect(result.state).toBe('stalled');
    expect(result.reason).toBe('dead_blocker');
  });

  test('one healthy blocker among dead ones is still a live path', () => {
    const result = liveness(row({ blockedBy: [BLOCKER_ID, OTHER_BLOCKER_ID] }), {
      blockers: [blocker(BLOCKER_ID, 'cancelled'), blocker(OTHER_BLOCKER_ID, 'todo')],
    });
    expect(result.state).toBe('blocked');
    expect(result.unresolvedBlockers).toEqual([BLOCKER_ID, OTHER_BLOCKER_ID]);
  });

  test('answer 4: a human assignee is a live path', () => {
    expect(liveness(row({ agent: null, assigneeUserId: USER_ID })).state).toBe('human');
  });

  test('answer 2: trigger lineage or a goal means a future fire will pick it up', () => {
    // Answer 2 is about work NOBODY HAS STARTED — hence `todo` rather than the
    // fixture's `doing`. A fire picks this up, claims it, and work begins.
    expect(liveness(row({ status: 'todo', triggerSlug: 'nightly' })).state).toBe('awaiting_trigger');
    expect(liveness(row({ status: 'todo', goalSlug: 'oil-desk' })).state).toBe('awaiting_trigger');
  });

  test('an expired claim with nothing else is stalled as claim_expired', () => {
    const result = liveness(expiredClaim(), { claimSession: 'terminal' });
    expect(result.state).toBe('stalled');
    expect(result.reason).toBe('claim_expired');
  });

  test('R-29: an agent-owned task with no claim, no blockers, no goal and no trigger is stalled', () => {
    const result = liveness(row({ status: 'todo' }));
    expect(result.state).toBe('stalled');
    expect(result.reason).toBe('no_live_path');
    expect(result.claimSession).toBeNull();
  });

  test('an existing recovery row rides along on every verdict', () => {
    const result = liveness(row({ status: 'todo' }), {
      recovery: { taskId: BLOCKER_ID, assigneeUserId: USER_ID, agent: null },
    });
    expect(result.recovery).toEqual({ taskId: BLOCKER_ID, escalated: true, escalatedTo: USER_ID });
  });

  test('an agent-owned recovery row reads as not yet escalated', () => {
    const result = liveness(row({ status: 'todo' }), {
      recovery: { taskId: BLOCKER_ID, assigneeUserId: null, agent: 'researcher' },
    });
    expect(result.recovery).toEqual({ taskId: BLOCKER_ID, escalated: false, escalatedTo: null });
  });
});

// ─── R-28 answer 5 / R-12g: the ask that reached a human, and the one that
// did not ────────────────────────────────────────────────────────────────────
//
// This block is the platinum.dev scenario, decided in a pure function. A 07:00
// push discovers it needs a Search Console grant. What happens next is the whole
// feature: if it delivered the ask to a named person the task is healthy and a
// human is on it; if it only wrote the ask down, the task is stalled and says so.

describe('resolveTaskLiveness — R-28 answer 5 (spec §4.3)', () => {
  test('answer 5: a DELIVERED pending request is a live path', () => {
    const result = liveness(row({ status: 'blocked' }), { request: request() });
    expect(result.state).toBe('awaiting_response');
    expect(result.reason).toBeNull();
    expect(result.request?.requestId).toBe('66666666-6666-4666-8666-666666666666');
  });

  test('R-12g: a request that reached NOBODY is a stall, not a live path', () => {
    const result = liveness(row({ status: 'blocked' }), {
      request: request({ delivered: false, deliveredVia: null, responderUserId: null }),
    });
    expect(result.state).toBe('stalled');
    expect(result.reason).toBe('request_undelivered');
    // The ask still rides along: a stall report has to say WHAT was needed.
    expect(result.request?.need).toBe('GOOGLE_SEARCH_CONSOLE_TOKEN');
  });

  test('THE regression: a goal-linked task blocked on a human no longer hides behind its push', () => {
    // The platinum.dev scenario, all three outcomes on one row. Before §4.3 all
    // three read `awaiting_trigger` — perfectly healthy — because the goal's
    // standing `push` does keep firing. It just cannot advance: every fire
    // re-derives the same block and stops at the same wall.
    const goalTask = row({ status: 'blocked', goalSlug: 'seo' });
    // Nobody told: the ask lives in a session log.
    expect(liveness(goalTask).reason).toBe('blocked_without_cause');
    // Told, but the ask reached nothing.
    expect(liveness(goalTask, { request: request({ delivered: false }) }).reason).toBe(
      'request_undelivered',
    );
    // Told, and it landed on a named person.
    expect(liveness(goalTask, { request: request() }).state).toBe('awaiting_response');
  });

  test('R-31: `blocked` with no edge and no ask is a block stated only in prose', () => {
    const result = liveness(row({ status: 'blocked', blockedBy: [] }));
    expect(result.state).toBe('stalled');
    expect(result.reason).toBe('blocked_without_cause');
  });

  test('a stated dependency is never mistaken for a prose block', () => {
    // R-16's whole job: `blocked_by` is how a task says what it waits on, and a
    // task that used it is healthy.
    expect(
      liveness(row({ status: 'blocked', blockedBy: [BLOCKER_ID] }), {
        blockers: [blocker(BLOCKER_ID, 'todo')],
      }).state,
    ).toBe('blocked');
  });

  test('only the `blocked` STATUS triggers it — a todo task under a goal is fine', () => {
    expect(liveness(row({ status: 'todo', goalSlug: 'seo' })).state).toBe('awaiting_trigger');
    expect(liveness(row({ status: 'backlog', goalSlug: 'seo' })).state).toBe('awaiting_trigger');
  });

  test('a human assignee on a blocked task is still a live path', () => {
    expect(
      liveness(row({ status: 'blocked', agent: null, assigneeUserId: USER_ID })).state,
    ).toBe('human');
  });

  test('a live claim still wins: a session working it is answer 1, ask or no ask', () => {
    expect(liveness(liveClaim(), { claimSession: 'active', request: request() }).state).toBe(
      'working',
    );
  });

  test('a healthy blocker outranks the ask, so the report keeps the more specific reason', () => {
    const result = liveness(row({ blockedBy: [BLOCKER_ID] }), {
      blockers: [blocker(BLOCKER_ID, 'doing')],
      request: request(),
    });
    expect(result.state).toBe('blocked');
    expect(result.request).not.toBeNull();
  });

  test('a delivered ask rescues a dead-blocker stall without pruning the edges', () => {
    const result = liveness(row({ blockedBy: [BLOCKER_ID] }), {
      blockers: [blocker(BLOCKER_ID, 'cancelled')],
      request: request(),
    });
    expect(result.state).toBe('awaiting_response');
    expect(result.reason).toBeNull();
    expect(result.unresolvedBlockers).toEqual([BLOCKER_ID]);
  });

  test('an UNdelivered ask does not rescue a dead-blocker stall', () => {
    const result = liveness(row({ blockedBy: [BLOCKER_ID] }), {
      blockers: [blocker(BLOCKER_ID, 'cancelled')],
      request: request({ delivered: false }),
    });
    expect(result.state).toBe('stalled');
    expect(result.reason).toBe('dead_blocker');
  });

  test('a human assignee is still answer 4 — someone already owns the work', () => {
    const result = liveness(row({ agent: null, assigneeUserId: USER_ID }), { request: request() });
    expect(result.state).toBe('human');
    expect(result.request).not.toBeNull();
  });

  test('a task with no ask at all is judged exactly as before', () => {
    expect(liveness(row({ status: 'todo' })).reason).toBe('no_live_path');
    expect(liveness(row({ status: 'todo' })).request).toBeNull();
  });
});

// ─── Defect A: a dead claim is not rescued by a trigger ──────────────────────
//
// `awaiting_trigger` sat ABOVE the claim branch, so a task with `goal_slug` set
// could never reach `claim_expired`. The AGI's own prompt tells it to create
// EVERY task with `--goal <slug>`, which made the branch unreachable for the
// whole board: measured with a matched pair, WITH a goal it read
// awaiting_trigger/null and WITHOUT it read stalled/claim_expired — same dead
// session, same lapsed lease, opposite verdicts.
//
// The line these tests hold: a future fire is answer 2 for work NOBODY HAS
// STARTED. It is not an answer for work that was started and dropped, because
// the fire re-derives the same half-finished state and stops.

describe('resolveTaskLiveness — a dead claim outranks a future fire', () => {
  test('THE matched pair: the goal-linked task is no longer the healthy one', () => {
    const withGoal = liveness(expiredClaim({ goalSlug: 'oil-desk' }), { claimSession: 'terminal' });
    const without = liveness(expiredClaim(), { claimSession: 'terminal' });

    // Identical evidence must produce an identical verdict. Before the fix the
    // first of these was `awaiting_trigger` with reason null.
    expect(withGoal.state).toBe('stalled');
    expect(withGoal.reason).toBe('claim_expired');
    expect(withGoal.state).toBe(without.state);
    expect(withGoal.reason).toBe(without.reason);
  });

  test('trigger lineage does not rescue a lapsed claim either', () => {
    const result = liveness(expiredClaim({ triggerSlug: 'nightly', goalSlug: null }), {
      claimSession: 'terminal',
    });
    expect(result.reason).toBe('claim_expired');
    // The claim session state rides along: a human triaging this wants to know
    // whether the holder is dead or merely unreachable.
    expect(result.claimSession).toBe('terminal');
  });

  test('a claim id that never resolved is still a lapsed claim, not a healthy goal', () => {
    // R-19 keeps `unknown` out of `terminal` for LIVE claims. Once the TTL has
    // passed that distinction stops mattering: nobody is on it either way.
    const result = liveness(expiredClaim({ goalSlug: 'oil-desk' }), { claimSession: 'unknown' });
    expect(result.reason).toBe('claim_expired');
    expect(result.claimSession).toBe('unknown');
  });

  test('what awaiting_trigger legitimately means: nobody has started it yet', () => {
    // No claim lineage, not in flight — the fire will find it in `todo`, claim
    // it, and work will begin. This is the case the branch exists for and it is
    // untouched.
    expect(liveness(row({ status: 'todo', goalSlug: 'oil-desk' })).state).toBe('awaiting_trigger');
    expect(liveness(row({ status: 'backlog', triggerSlug: 'nightly' })).state).toBe(
      'awaiting_trigger',
    );
  });

  test('the sweep’s own fix: a released claim leaves work in flight with nobody on it', () => {
    // This is the row `releaseTask` produces — claim triple cleared, status
    // untouched (R-31: a session ending is not a status change). The evidence
    // that it was ever claimed is GONE, which is why the reason cannot lean on
    // it, and why this branch has to read the status instead.
    const released = row({ status: 'doing', goalSlug: 'oil-desk', claimSessionId: null });
    const result = liveness(released);
    expect(result.state).toBe('stalled');
    expect(result.reason).toBe('abandoned_in_flight');
    // Nothing to name: no session holds it.
    expect(result.claimSession).toBeNull();
  });

  test('a released claim on work nobody had started is genuinely fixed by the release', () => {
    // The counter-case, and the reason `abandoned_in_flight` reads the status
    // rather than firing on every claimless row: the lease was the only thing in
    // this task's way, and clearing it restored answer 2.
    expect(liveness(row({ status: 'todo', goalSlug: 'oil-desk', claimSessionId: null })).state).toBe(
      'awaiting_trigger',
    );
  });

  test('the in-flight vocabulary is one status wide', () => {
    // `review` says the work is finished and something else is owed; `todo` says
    // nobody started. Neither contradicts an empty claim, and condemning them
    // would bury the signal under every task on the board.
    expect(liveness(row({ status: 'review', goalSlug: 'oil-desk' })).state).toBe('awaiting_trigger');
    expect(liveness(row({ status: 'todo', goalSlug: 'oil-desk' })).state).toBe('awaiting_trigger');
  });

  test('the lapsed lease is the more specific evidence when both are true', () => {
    // status `doing` AND a claim id: report the reason that names who dropped it.
    expect(liveness(expiredClaim({ goalSlug: 'oil-desk' })).reason).toBe('claim_expired');
  });

  test('a task in flight with no goal and no claim is not reported as unscheduled', () => {
    // `no_live_path` means "a human never scheduled this". A task that says a
    // session is on it right now was scheduled — and then abandoned.
    expect(liveness(row({ status: 'doing' })).reason).toBe('abandoned_in_flight');
    expect(liveness(row({ status: 'todo' })).reason).toBe('no_live_path');
  });

  test('a live claim still wins — none of this touches answer 1', () => {
    expect(liveness(liveClaim({ goalSlug: 'oil-desk' }), { claimSession: 'active' }).state).toBe(
      'working',
    );
  });

  test('a human assignee and a stated blocker still outrank the dropped claim', () => {
    expect(
      liveness(expiredClaim({ agent: null, assigneeUserId: USER_ID, goalSlug: 'oil-desk' })).state,
    ).toBe('human');
    expect(
      liveness(expiredClaim({ blockedBy: [BLOCKER_ID], goalSlug: 'oil-desk' }), {
        blockers: [blocker(BLOCKER_ID, 'doing')],
      }).state,
    ).toBe('blocked');
  });

  test('a delivered ask still outranks it — asked-and-waiting is not abandoned', () => {
    // The §4.3 path: the session claimed the task, hit a wall, told a named
    // human, and ended. The claim lapsing afterwards does not undo the ask.
    const result = liveness(expiredClaim({ goalSlug: 'oil-desk' }), { request: request() });
    expect(result.state).toBe('awaiting_response');
  });

  test('recovery is reachable for the states this unlocks', () => {
    // The whole consequence of the ordering bug: R-32 could never run on a
    // goal-linked task, because the reasons it acts on were unreachable.
    expect(
      isRecoverableStall({ reason: 'claim_expired', hadClaim: true, hasRecovery: false }),
    ).toBe(true);
    expect(
      isRecoverableStall({ reason: 'abandoned_in_flight', hadClaim: true, hasRecovery: false }),
    ).toBe(true);
    // And after the release erased the claim, the recovery row keeps it reachable.
    expect(
      isRecoverableStall({ reason: 'abandoned_in_flight', hadClaim: false, hasRecovery: true }),
    ).toBe(true);
  });
});

// ─── Defect B: an ask nobody answered ────────────────────────────────────────
//
// `isLiveRequest` was (pending && delivered) with no age term, so ONE delivered
// row propped a task up as `awaiting_response` forever. Reproduced at 45 days
// unanswered on a board that reported `stalled_count: 0`. On a fresh workspace
// every delivery is the `inbox` tier — a row a human has to go looking for — and
// R-12g deliberately buys no second nag, so nothing was ever going to change
// that verdict.

describe('resolveTaskLiveness — an ask stops being a live path (spec §4.3)', () => {
  test('45 days unanswered is a stall that names the ask and its age', () => {
    const result = liveness(row({ status: 'blocked', goalSlug: 'seo' }), {
      request: delivered(45 * DAY, { deliveredVia: 'inbox' }),
    });
    expect(result.state).toBe('stalled');
    expect(result.reason).toBe('request_unanswered');
    // The ask itself, so the report can say WHAT is owed and by WHOM.
    expect(result.request?.need).toBe('GOOGLE_SEARCH_CONSOLE_TOKEN');
    expect(result.request?.responderUserId).toBe(USER_ID);
    expect(result.requestUnansweredForMs).toBe(45 * DAY);
    // And the threshold that produced the verdict, like flat_stall_after.
    expect(result.requestUnansweredAfterMs).toBe(UNANSWERED_AFTER);
  });

  test('a fresh ask is still answer 5 — this is a window, not a repeal', () => {
    const result = liveness(row({ status: 'blocked' }), { request: delivered(HOUR) });
    expect(result.state).toBe('awaiting_response');
    expect(result.reason).toBeNull();
    expect(result.requestUnansweredForMs).toBe(HOUR);
  });

  test('the boundary is inclusive: at the window it has waited long enough', () => {
    expect(liveness(row({ status: 'blocked' }), { request: delivered(UNANSWERED_AFTER) }).reason).toBe(
      'request_unanswered',
    );
    expect(
      liveness(row({ status: 'blocked' }), { request: delivered(UNANSWERED_AFTER - 1) }).state,
    ).toBe('awaiting_response');
  });

  test('the window is configurable per pass, and the verdict says which one ran', () => {
    const task = row({ status: 'blocked' });
    const week = delivered(7 * DAY);
    expect(liveness(task, { request: week, requestUnansweredAfterMs: 30 * DAY }).state).toBe(
      'awaiting_response',
    );
    const strict = liveness(task, { request: week, requestUnansweredAfterMs: DAY });
    expect(strict.reason).toBe('request_unanswered');
    expect(strict.requestUnansweredAfterMs).toBe(DAY);
  });

  test('unanswered is NOT undelivered — the two failures have different fixes', () => {
    // Deliver it, versus go and answer it. Reporting either as the other sends a
    // human to the wrong place.
    expect(
      liveness(row({ status: 'blocked' }), { request: delivered(45 * DAY) }).reason,
    ).toBe('request_unanswered');
    expect(
      liveness(row({ status: 'blocked' }), {
        request: request({ delivered: false, deliveredAt: null, deliveredVia: null }),
      }).reason,
    ).toBe('request_undelivered');
  });

  test('an ask nobody answered no longer hides a goal-linked task behind its push', () => {
    // The same sentence as §4.3's original regression, one step further along: a
    // standing push does keep firing, and it does keep hitting the same wall,
    // whether the ask was never sent or merely never read.
    const task = row({ status: 'todo', goalSlug: 'seo' });
    expect(liveness(task, { request: delivered(HOUR) }).state).toBe('awaiting_response');
    expect(liveness(task, { request: delivered(45 * DAY) }).state).toBe('stalled');
  });

  test('an overdue ask stops rescuing a dead-blocker stall', () => {
    const result = liveness(row({ blockedBy: [BLOCKER_ID] }), {
      blockers: [blocker(BLOCKER_ID, 'cancelled')],
      request: delivered(45 * DAY),
    });
    expect(result.state).toBe('stalled');
    // The blockers are the more specific evidence and they keep the reason; the
    // ask still rides along, aged, so the report holds both facts.
    expect(result.reason).toBe('dead_blocker');
    expect(result.requestUnansweredForMs).toBe(45 * DAY);
  });

  test('an unanswered ask is surfaced and NEVER continued (R-29)', () => {
    // No task this system manufactures can perform the human act that would
    // unstick the work, and escalating would hand the owner a task whose whole
    // content is "somebody did not answer a question" — competing with the ask.
    expect(
      isRecoverableStall({ reason: 'request_unanswered', hadClaim: true, hasRecovery: false }),
    ).toBe(false);
    expect(
      isRecoverableStall({ reason: 'request_unanswered', hadClaim: true, hasRecovery: true }),
    ).toBe(false);
  });

  test('a caller that supplies no delivery timestamp ages nothing out', () => {
    // The session-terminal writeback builds its ref from the boolean alone.
    // Inventing an age for it would stall a task on a fact nobody has.
    const result = liveness(row({ status: 'blocked' }), {
      request: request({ deliveredAt: undefined }),
    });
    expect(result.state).toBe('awaiting_response');
    expect(result.requestUnansweredForMs).toBeNull();
  });

  test('an undelivered ask has no age at all — there is nothing to wait since', () => {
    const result = liveness(row({ status: 'blocked' }), {
      request: request({ delivered: false, deliveredAt: null }),
    });
    expect(result.requestUnansweredForMs).toBeNull();
  });

  test('a live claim outranks even a badly overdue ask — answer 1 is still first', () => {
    expect(
      liveness(liveClaim(), { claimSession: 'active', request: delivered(45 * DAY) }).state,
    ).toBe('working');
  });
});

describe('continuation copy', () => {
  test('the title is derived so a repeat sweep produces a byte-identical row', () => {
    expect(continuationTitle('Ship it')).toBe(`${CONTINUATION_TITLE_PREFIX} Ship it`);
    expect(continuationTitle('Ship it', true)).toBe(`${ESCALATION_TITLE_PREFIX} Ship it`);
  });

  test('a long title is truncated to the column limit rather than rejected', () => {
    const title = continuationTitle('x'.repeat(600));
    expect(title.length).toBe(500);
    expect(title.endsWith('...')).toBe(true);
  });

  test('the body carries cause and evidence, including the session it does not key on', () => {
    const body = continuationBody({
      taskId: TASK_ID,
      reason: 'claim_expired',
      evidence: 'untouched_since_claim',
      sessionId: 'ses_dead',
      observedAt: NOW,
    });
    expect(body).toContain('reason: claim_expired');
    expect(body).toContain('evidence: untouched_since_claim');
    expect(body).toContain('ses_dead');
    expect(body).toContain(NOW.toISOString());
  });

  test('a stall observed with no claim holder still reads cleanly', () => {
    expect(
      continuationBody({
        taskId: TASK_ID,
        reason: 'no_live_path',
        evidence: 'untouched_since_claim',
        sessionId: null,
        observedAt: NOW,
      }),
    ).toContain('last claim session: none');
  });
});

describe('serializeTaskLiveness', () => {
  test('the wire shape is snake_case and keeps nulls explicit', () => {
    expect(serializeTaskLiveness(liveness(row({ status: 'todo' })))).toEqual({
      state: 'stalled',
      reason: 'no_live_path',
      claim_session_state: null,
      unresolved_blockers: [],
      recovery: null,
      request: null,
      request_unanswered_after_ms: UNANSWERED_AFTER,
      request_unanswered_for_ms: null,
    });
  });

  test('R-12g: the pending request rides along on the wire, delivery included', () => {
    const serialized = serializeTaskLiveness(
      liveness(row({ status: 'todo', goalSlug: 'seo' }), { request: request() }),
    );
    expect(serialized.state).toBe('awaiting_response');
    expect(serialized.request).toEqual({
      request_id: '66666666-6666-4666-8666-666666666666',
      kind: 'secret',
      need: 'GOOGLE_SEARCH_CONSOLE_TOKEN',
      responder_user_id: USER_ID,
      delivered: true,
      delivered_via: 'slack',
      delivered_at: new Date(NOW.getTime() - HOUR).toISOString(),
    });
  });

  test('the age and the window are on the wire, so a stall report can say them', () => {
    const serialized = serializeTaskLiveness(
      liveness(row({ status: 'blocked', goalSlug: 'seo' }), { request: delivered(45 * DAY) }),
    );
    expect(serialized.reason).toBe('request_unanswered');
    expect(serialized.request_unanswered_for_ms).toBe(45 * DAY);
    expect(serialized.request_unanswered_after_ms).toBe(UNANSWERED_AFTER);
  });

  test('a recovery row serializes with its escalation target', () => {
    const serialized = serializeTaskLiveness(
      liveness(row({ status: 'todo' }), {
        recovery: { taskId: BLOCKER_ID, assigneeUserId: USER_ID, agent: null },
      }),
    );
    expect(serialized.recovery).toEqual({
      task_id: BLOCKER_ID,
      escalated: true,
      escalated_to: USER_ID,
    });
  });
});

// ─── R-12d/R-12e: the goal half of the same surface ─────────────────────────

describe('resolveGoalLiveness', () => {
  const AT = new Date('2026-07-27T09:00:00.000Z');

  /** Newest first, the order summarizeMetric consumes. */
  function series(name: string, ...values: number[]): GoalMetricSummary {
    return summarizeMetric(
      name,
      values.map((value, index) => ({
        value,
        observedAt: new Date(AT.getTime() - index * 86_400_000),
        source: 'session:s1',
      })),
      50,
    )!;
  }

  const active = (metrics: GoalMetricSummary[], doneWhen = 'Top 3 for the core terms.') =>
    resolveGoalLiveness({ status: 'active', doneWhen, metrics, flatStallAfter: 3 });

  test('achieved and abandoned are settled — outside the question, like a done task', () => {
    for (const status of ['achieved', 'abandoned']) {
      expect(
        resolveGoalLiveness({ status, doneWhen: 'Top 3.', metrics: [], flatStallAfter: 3 }).state,
      ).toBe('settled');
    }
  });

  test('a paused goal is paused, not stalled — pausing is a choice, not a defect', () => {
    expect(
      resolveGoalLiveness({ status: 'paused', doneWhen: 'Top 3.', metrics: [], flatStallAfter: 3 })
        .state,
    ).toBe('paused');
  });

  // R-12d. The whole point: "be #1 on Google" with nothing ever recorded is not
  // progressing slowly, it is un-judged — and it must never read as on-track.
  test('a threshold with zero observations is UNMEASURABLE, never measuring and never stalled', () => {
    const verdict = active([], 'Be #1 on Google for the core terms.');
    expect(verdict.state).toBe('unmeasurable');
    expect(verdict.reason).toBeNull();
  });

  test('prose with no threshold and no observations is UNQUANTIFIED — a different problem', () => {
    expect(active([], 'An offer is signed and a start date is on the calendar.').state).toBe(
      'unquantified',
    );
  });

  test('a metric that moved is measuring, with no flat metrics reported', () => {
    const verdict = active([series('rank', 9, 12, 12, 12)]);
    expect(verdict.state).toBe('measuring');
    expect(verdict.flatMetrics).toEqual([]);
  });

  test('a flat run short of the threshold is not yet a stall', () => {
    expect(active([series('rank', 9, 9, 9)]).state).toBe('measuring');
  });

  // R-12e, and the failure the whole section exists for: three weeks of a loop
  // that looks alive while the number has not moved.
  test('a metric flat across N consecutive readings is a stall, named and counted', () => {
    const verdict = active([series('rank', 9, 9, 9, 9)]);
    expect(verdict.state).toBe('stalled');
    expect(verdict.reason).toBe('metric_flat');
    expect(verdict.flatMetrics).toEqual([{ metric: 'rank', flatObservations: 3 }]);
    expect(verdict.flatStallAfter).toBe(3);
  });

  // The defect this rule was rewritten for. Under the old "EVERY metric must be
  // flat" reading this returned `measuring`: rank pinned for a week, signups
  // wandering, stalled_goal_count 0. One noisy metric hid the flat one.
  test('a noisy metric no longer hides a flat one — ANY flat metric stalls an undeclared goal', () => {
    const verdict = active([series('rank', 9, 9, 9, 9), series('signups', 40, 31)]);
    expect(verdict.state).toBe('stalled');
    expect(verdict.reason).toBe('metric_flat');
    expect(verdict.rule).toBe('any_metric');
    expect(verdict.drivenBy).toBe('rank');
  });

  test('every metric flat is a stall, worst flat run first and named as the driver', () => {
    const verdict = active([series('rank', 9, 9, 9, 9), series('signups', 40, 40, 40, 40, 40)]);
    expect(verdict.state).toBe('stalled');
    expect(verdict.flatMetrics.map((m) => m.metric)).toEqual(['signups', 'rank']);
    expect(verdict.drivenBy).toBe('signups');
  });

  // R-12e with a declaration. THAT metric is the verdict; the others are context.
  const declared = (metrics: GoalMetricSummary[], primaryMetric: string) =>
    resolveGoalLiveness({
      status: 'active',
      doneWhen: 'Top 3 for the core terms.',
      metrics,
      flatStallAfter: 3,
      primaryMetric,
    });

  test('a declared primary that is flat stalls the goal however loudly the others move', () => {
    const verdict = declared(
      [
        series('gsc_avg_position_core', 9.4, 9.4, 9.4, 9.4),
        series('impressions', 5100, 4800, 5300),
        series('clicks', 61, 44, 70),
      ],
      'gsc_avg_position_core',
    );
    expect(verdict.state).toBe('stalled');
    expect(verdict.rule).toBe('primary');
    expect(verdict.drivenBy).toBe('gsc_avg_position_core');
    expect(verdict.primaryMetric).toBe('gsc_avg_position_core');
  });

  test('a flat SECONDARY never condemns a declared goal, and is still reported by name', () => {
    const verdict = declared(
      [series('gsc_avg_position_core', 9.4, 8.1, 7.2), series('clicks', 61, 61, 61, 61)],
      'gsc_avg_position_core',
    );
    expect(verdict.state).toBe('measuring');
    expect(verdict.rule).toBe('primary');
    expect(verdict.drivenBy).toBeNull();
    // Visible, but not the verdict — the distinction `rule` exists to make.
    expect(verdict.flatMetrics.map((m) => m.metric)).toEqual(['clicks']);
  });

  // R-12d, per-metric. The strongest possible signal: the goal names the number
  // it is about and nobody has ever taken it. Three healthy-looking unrelated
  // series make that worse, not better.
  test('a declared primary that was NEVER observed is unmeasurable, not measuring', () => {
    const verdict = declared(
      [series('impressions', 5100, 4800), series('clicks', 61, 44)],
      'gsc_avg_position_core',
    );
    expect(verdict.state).toBe('unmeasurable');
    expect(verdict.reason).toBeNull();
    expect(verdict.primaryMetric).toBe('gsc_avg_position_core');
  });

  test('the threshold is carried on the verdict so a caller never has to guess which N ran', () => {
    const verdict = resolveGoalLiveness({
      status: 'active',
      doneWhen: 'Top 3.',
      metrics: [series('rank', 9, 9, 9, 9)],
      flatStallAfter: 5,
    });
    expect(verdict.state).toBe('measuring');
    expect(verdict.flatStallAfter).toBe(5);
  });

  test('serializes to the snake_case wire shape', () => {
    expect(serializeGoalLiveness(active([series('rank', 9, 9, 9, 9)]))).toEqual({
      state: 'stalled',
      reason: 'metric_flat',
      flat_metrics: [{ metric: 'rank', flat_observations: 3 }],
      flat_stall_after: 3,
      stall_rule: 'any_metric',
      driven_by: 'rank',
      primary_metric: null,
    });
  });
});
