import { describe, expect, test } from 'bun:test';
import {
  parseClaimBody,
  parseCreateTaskBody,
  parsePatchTaskBody,
  parseReleaseBody,
  idsNeedingResolution,
} from './input';
import {
  OPEN_TASK_STATUSES,
  decodeTaskCursor,
  dedupeIds,
  encodeTaskCursor,
  orderBlockers,
  parseAssigneeFilter,
  parseBoundedInteger,
  parseClaimFilter,
  parseNullableFilter,
  parseStatusFilter,
  serializeAgiTask,
  type AgiTaskRow,
} from './wire';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';

function row(overrides: Partial<AgiTaskRow> = {}): AgiTaskRow {
  return {
    taskId: TASK_ID,
    workspaceId: OTHER_ID,
    parentId: null,
    goalSlug: null,
    project: null,
    title: 'Ship it',
    body: null,
    status: 'todo',
    priority: 'medium',
    agent: null,
    assigneeUserId: null,
    blockedBy: [],
    triggerSlug: null,
    claimSessionId: null,
    claimedAt: null,
    claimExpiresAt: null,
    origin: 'human',
    originFingerprint: null,
    createdAt: new Date('2026-07-26T10:00:00.000Z'),
    updatedAt: new Date('2026-07-26T10:00:00.000Z'),
    ...overrides,
  } as AgiTaskRow;
}

describe('serializeAgiTask', () => {
  test('claimed is derived from the server clock, not from the claim column alone', () => {
    const held = row({
      claimSessionId: 'ses_1',
      claimedAt: new Date('2026-07-26T10:00:00.000Z'),
      claimExpiresAt: new Date('2026-07-26T10:15:00.000Z'),
    });
    expect(serializeAgiTask(held, new Date('2026-07-26T10:05:00.000Z')).claimed).toBe(true);
    expect(serializeAgiTask(held, new Date('2026-07-26T10:20:00.000Z')).claimed).toBe(false);
  });

  test('an unclaimed row is never claimed and reports null timestamps', () => {
    const wire = serializeAgiTask(row());
    expect(wire.claimed).toBe(false);
    expect(wire.claimed_at).toBeNull();
    expect(wire.claim_expires_at).toBeNull();
    expect(wire.created_at).toBe('2026-07-26T10:00:00.000Z');
  });
});

describe('cursor codec', () => {
  test('round-trips created_at and task_id', () => {
    const cursor = decodeTaskCursor(encodeTaskCursor(row()));
    expect(cursor).toEqual({ createdAt: '2026-07-26T10:00:00.000Z', taskId: TASK_ID });
  });

  test.each([['not-base64-at-all'], [Buffer.from('nope').toString('base64url')], [Buffer.from('2026-07-26T10:00:00.000Z|not-a-uuid').toString('base64url')], [Buffer.from(`not-a-date|${TASK_ID}`).toString('base64url')]])(
    'rejects %p',
    (raw) => {
      expect(decodeTaskCursor(raw)).toBeNull();
    },
  );
});

describe('parseStatusFilter', () => {
  test('defaults to open', () => {
    expect(parseStatusFilter(undefined)).toEqual({ kind: 'in', statuses: [...OPEN_TASK_STATUSES] });
  });

  test('open expands and unions with explicit statuses without duplicating', () => {
    expect(parseStatusFilter('open,done,todo')).toEqual({
      kind: 'in',
      statuses: [...OPEN_TASK_STATUSES, 'done'],
    });
  });

  test('all disables the filter but may not be mixed', () => {
    expect(parseStatusFilter('all')).toEqual({ kind: 'all' });
    expect(parseStatusFilter('all,done')).toBeNull();
  });

  test('rejects an unknown status', () => {
    expect(parseStatusFilter('todo,shipped')).toBeNull();
  });
});

describe('filter parsers', () => {
  test('assignee understands agent, user, none and any', () => {
    expect(parseAssigneeFilter('agent:researcher')).toEqual({ kind: 'agent', agent: 'researcher' });
    expect(parseAssigneeFilter(`user:${USER_ID}`)).toEqual({ kind: 'user', userId: USER_ID });
    expect(parseAssigneeFilter('none')).toEqual({ kind: 'none' });
    expect(parseAssigneeFilter('any')).toEqual({ kind: 'any' });
  });

  test('assignee rejects a bare name, an empty agent and a non-uuid user', () => {
    expect(parseAssigneeFilter('researcher')).toBeNull();
    expect(parseAssigneeFilter('agent:')).toBeNull();
    expect(parseAssigneeFilter('user:nope')).toBeNull();
  });

  test('none maps to IS NULL on a nullable column', () => {
    expect(parseNullableFilter('none')).toEqual({ kind: 'none' });
    expect(parseNullableFilter('oil-desk')).toEqual({ kind: 'value', value: 'oil-desk' });
    expect(parseNullableFilter('')).toBeNull();
  });

  test('claim accepts only free and held', () => {
    expect(parseClaimFilter('free')).toBe('free');
    expect(parseClaimFilter('held')).toBe('held');
    expect(parseClaimFilter('expired')).toBeNull();
  });

  test('bounded integer takes the fallback when absent and rejects out of range', () => {
    const bounds = { min: 1, max: 200, fallback: 50 };
    expect(parseBoundedInteger(undefined, bounds)).toBe(50);
    expect(parseBoundedInteger('200', bounds)).toBe(200);
    expect(parseBoundedInteger('201', bounds)).toBeNull();
    expect(parseBoundedInteger('0', bounds)).toBeNull();
    expect(parseBoundedInteger('-1', bounds)).toBeNull();
    expect(parseBoundedInteger('1.5', bounds)).toBeNull();
  });
});

describe('orderBlockers', () => {
  test('returns blockers in blocked_by order and reports unresolvable ids', () => {
    const blocker = row({ taskId: OTHER_ID });
    const { blockers, missing } = orderBlockers([USER_ID, OTHER_ID], [blocker]);
    expect(blockers.map((b) => b.taskId)).toEqual([OTHER_ID]);
    expect(missing).toEqual([USER_ID]);
  });

  test('a cancelled blocker is returned like any other — the edge is not pruned (R-17)', () => {
    const cancelled = row({ taskId: OTHER_ID, status: 'cancelled' });
    const { blockers, missing } = orderBlockers([OTHER_ID], [cancelled]);
    expect(blockers).toHaveLength(1);
    expect(blockers[0].status).toBe('cancelled');
    expect(missing).toEqual([]);
  });
});

describe('dedupeIds', () => {
  test('preserves first-seen order', () => {
    expect(dedupeIds([OTHER_ID, TASK_ID, OTHER_ID])).toEqual([OTHER_ID, TASK_ID]);
  });
});

describe('parseCreateTaskBody', () => {
  test('applies the documented defaults', () => {
    const parsed = parseCreateTaskBody({ title: '  Ship it  ', origin: 'agi' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toMatchObject({
      title: 'Ship it',
      status: 'backlog',
      priority: 'medium',
      origin: 'agi',
      blockedBy: [],
    });
  });

  test('origin is required with no default', () => {
    const parsed = parseCreateTaskBody({ title: 'Ship it' });
    expect(parsed).toEqual({ ok: false, error: { error: 'Invalid origin' } });
  });

  test('an empty or whitespace title is rejected', () => {
    expect(parseCreateTaskBody({ title: '   ', origin: 'human' })).toEqual({
      ok: false,
      error: { error: 'title is required' },
    });
  });

  test('a title over 500 characters is rejected', () => {
    const parsed = parseCreateTaskBody({ title: 'x'.repeat(501), origin: 'human' });
    expect(parsed.ok).toBe(false);
  });

  test('two assignees are rejected before any SQL runs (R-14)', () => {
    expect(
      parseCreateTaskBody({
        title: 'Ship it',
        origin: 'human',
        agent: 'researcher',
        assignee_user_id: USER_ID,
      }),
    ).toEqual({ ok: false, error: { error: 'A task has at most one assignee', code: 'two_assignees' } });
  });

  test('blocked_by is de-duplicated in first-seen order', () => {
    const parsed = parseCreateTaskBody({
      title: 'Ship it',
      origin: 'human',
      blocked_by: [OTHER_ID, TASK_ID, OTHER_ID],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.blockedBy).toEqual([OTHER_ID, TASK_ID]);
  });

  test('a non-uuid blocker is rejected', () => {
    const parsed = parseCreateTaskBody({ title: 'Ship it', origin: 'human', blocked_by: ['nope'] });
    expect(parsed.ok).toBe(false);
  });
});

describe('parsePatchTaskBody', () => {
  test('an empty body has nothing to update', () => {
    expect(parsePatchTaskBody({})).toEqual({ ok: false, error: { error: 'No fields to update' } });
  });

  test.each(['task_id', 'workspace_id', 'origin', 'origin_fingerprint', 'claim_session_id', 'claimed_at', 'claim_expires_at', 'created_at', 'updated_at'])(
    'names %s as not patchable',
    (field) => {
      expect(parsePatchTaskBody({ [field]: 'x' })).toEqual({
        ok: false,
        error: { error: `${field} is not patchable` },
      });
    },
  );

  test('explicit null clears a field and an absent key leaves it alone', () => {
    const parsed = parsePatchTaskBody({ goal_slug: null });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({ goalSlug: null });
    expect('project' in parsed.value).toBe(false);
  });

  test('setting an agent implicitly clears the human assignee (R-14)', () => {
    const parsed = parsePatchTaskBody({ agent: 'researcher' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({ agent: 'researcher', assigneeUserId: null });
  });

  test('setting a human assignee implicitly clears the agent (R-14)', () => {
    const parsed = parsePatchTaskBody({ assignee_user_id: USER_ID });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({ assigneeUserId: USER_ID, agent: null });
  });

  test('both assignees non-null in one request is a 400, not a CHECK violation', () => {
    expect(parsePatchTaskBody({ agent: 'researcher', assignee_user_id: USER_ID })).toEqual({
      ok: false,
      error: { error: 'A task has at most one assignee', code: 'two_assignees' },
    });
  });

  test('clearing one assignee while naming the other is allowed', () => {
    const parsed = parsePatchTaskBody({ agent: 'researcher', assignee_user_id: null });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({ agent: 'researcher', assigneeUserId: null });
  });

  test('blocked_by is a full replacement, including an empty array', () => {
    const parsed = parsePatchTaskBody({ blocked_by: [] });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({ blockedBy: [] });
  });
});

describe('parseClaimBody', () => {
  test('defaults the ttl to 900 seconds', () => {
    expect(parseClaimBody({ session_id: 'ses_1' })).toEqual({
      ok: true,
      value: { sessionId: 'ses_1', ttlSeconds: 900, status: undefined },
    });
  });

  test.each([[29], [86_401], [1.5]])('rejects a ttl of %p', (ttl) => {
    expect(parseClaimBody({ session_id: 'ses_1', ttl_seconds: ttl })).toEqual({
      ok: false,
      error: { error: 'Invalid ttl_seconds' },
    });
  });

  test('requires a non-empty session id', () => {
    expect(parseClaimBody({}).ok).toBe(false);
    expect(parseClaimBody({ session_id: '   ' }).ok).toBe(false);
  });

  test('a terminal status may not be claimed into', () => {
    expect(parseClaimBody({ session_id: 'ses_1', status: 'done' })).toEqual({
      ok: false,
      error: { error: 'Cannot claim a task into a terminal status' },
    });
  });

  test('doing and review ride along on the same statement', () => {
    expect(parseClaimBody({ session_id: 'ses_1', status: 'doing' })).toMatchObject({
      ok: true,
      value: { status: 'doing' },
    });
  });
});

describe('parseReleaseBody', () => {
  test('requires the holder session id', () => {
    expect(parseReleaseBody({}).ok).toBe(false);
  });

  test('carries an optional status', () => {
    expect(parseReleaseBody({ session_id: 'ses_1', status: 'review' })).toEqual({
      ok: true,
      value: { sessionId: 'ses_1', status: 'review' },
    });
  });
});

describe('idsNeedingResolution', () => {
  test('merges the parent and every blocker, de-duplicated', () => {
    expect(idsNeedingResolution({ parentId: OTHER_ID, blockedBy: [OTHER_ID, TASK_ID] })).toEqual([
      OTHER_ID,
      TASK_ID,
    ]);
  });

  test('ignores a null parent and an absent blocker list', () => {
    expect(idsNeedingResolution({ parentId: null })).toEqual([]);
  });
});
