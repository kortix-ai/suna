import { describe, expect, test } from 'bun:test';
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
} from './wire';
import { summarizeMetric, type GoalMetricSummary } from '../observations/wire';
import type { AgiTaskRow } from '../tasks/wire';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const BLOCKER_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_BLOCKER_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-07-27T12:00:00.000Z');

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
    ...extra,
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
    const result = liveness(row({ blockedBy: [BLOCKER_ID], goalSlug: 'oil-desk' }), {
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
    expect(liveness(row({ triggerSlug: 'nightly' })).state).toBe('awaiting_trigger');
    expect(liveness(row({ goalSlug: 'oil-desk' })).state).toBe('awaiting_trigger');
  });

  test('an expired claim is not a live path (R-30) and falls through to the goal', () => {
    const expired = row({
      goalSlug: 'oil-desk',
      claimSessionId: 'ses_dead',
      claimedAt: new Date('2026-07-27T10:00:00.000Z'),
      claimExpiresAt: new Date('2026-07-27T10:15:00.000Z'),
    });
    expect(liveness(expired, { claimSession: 'terminal' }).state).toBe('awaiting_trigger');
  });

  test('an expired claim with nothing else is stalled as claim_expired', () => {
    const expired = row({
      claimSessionId: 'ses_dead',
      claimedAt: new Date('2026-07-27T10:00:00.000Z'),
      claimExpiresAt: new Date('2026-07-27T10:15:00.000Z'),
    });
    const result = liveness(expired, { claimSession: 'terminal' });
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
    });
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

  test('one metric still moving keeps the goal measuring — something got closer', () => {
    const verdict = active([series('rank', 9, 9, 9, 9), series('signups', 40, 31)]);
    expect(verdict.state).toBe('measuring');
    // The flat one is still reported by name, so it is visible before it stalls
    // the whole goal.
    expect(verdict.flatMetrics.map((m) => m.metric)).toEqual(['rank']);
  });

  test('every metric flat is a stall, worst flat run first', () => {
    const verdict = active([series('rank', 9, 9, 9, 9), series('signups', 40, 40, 40, 40, 40)]);
    expect(verdict.state).toBe('stalled');
    expect(verdict.flatMetrics.map((m) => m.metric)).toEqual(['signups', 'rank']);
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
    });
  });
});
