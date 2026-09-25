import { describe, expect, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { LIFECYCLE_CLAIM_LOCK_MS } from './command-lease';
import {
  LIFECYCLE_RUNNING_RECLAIM_GRACE_MS,
  buildContinueSessionCommandValues,
  buildCreateSessionCommandValues,
  createSessionCommandPayload,
  withRemintedWireId,
} from './store';
import type { CreateSessionCommand } from './types';

const BASE: CreateSessionCommand = {
  source: 'ui',
  project: {} as CreateSessionCommand['project'],
  userId: 'user-1',
  requestingPrincipalType: 'human',
  body: { initial_prompt: 'hi' },
};

describe('createSessionCommandPayload', () => {
  test('carries the origin-derivation signals through the queue', () => {
    const payload = createSessionCommandPayload({
      ...BASE,
      authType: 'pat',
      apiKeyType: 'user',
      inSession: false,
    });
    expect(payload.authType).toBe('pat');
    expect(payload.apiKeyType).toBe('user');
    expect(payload.inSession).toBe(false);
    expect(payload.body).toEqual({ initial_prompt: 'hi' });
  });

  test('absent signals stay absent (pre-origin queued rows replay as user)', () => {
    const payload = createSessionCommandPayload(BASE);
    expect(payload.authType).toBeUndefined();
    expect(payload.apiKeyType).toBeUndefined();
    expect(payload.inSession).toBeUndefined();
  });
});

describe('withRemintedWireId', () => {
  const compile = (id: string) => {
    const q = new PgDialect().sqlToQuery(withRemintedWireId(id));
    return { sql: q.sql.replace(/\s+/g, ' ').trim(), params: q.params };
  };

  test('sets the scalar to the newest id AND appends it to the array', () => {
    // The scalar `redeliveredMessageId` is the merge's job (`|| $1`); the array
    // `redeliveredMessageIds` grows by one (`coalesce(...,'[]') || $2`). The two
    // are DIFFERENT shapes on purpose — one id vs the whole history — so a
    // ledger row keyed on any earlier re-minted id still matches.
    const { sql, params } = compile('msg_second');
    expect(sql).toBe(
      'jsonb_set( "kortix"."session_lifecycle_commands"."payload" || $1::jsonb,' +
        " '{redeliveredMessageIds}'," +
        ' coalesce("kortix"."session_lifecycle_commands"."payload"->\'redeliveredMessageIds\', \'[]\'::jsonb) || $2::jsonb)',
    );
    // First param sets the scalar; second appends exactly one element.
    expect(params).toEqual(['{"redeliveredMessageId":"msg_second"}', '["msg_second"]']);
  });

  test('the append reads the CURRENT array — a second re-mint keeps the first id', () => {
    // `coalesce(payload->'redeliveredMessageIds', '[]')` is the running list, so
    // each call concatenates rather than replaces. Two calls leave BOTH ids in
    // the column, which is the whole point of the change.
    expect(compile('msg_a').params[1]).toBe('["msg_a"]');
    expect(compile('msg_b').params[1]).toBe('["msg_b"]');
  });
});

test('durable prompt payload preserves its presentation placement', () => {
  const values = buildContinueSessionCommandValues({
    source: 'ui', projectId: 'p', accountId: 'a', sessionId: 's', actorUserId: 'u',
    text: 'follow up', placement: 'transcript',
  });
  expect(values.payload.placement).toBe('transcript');
});

describe('buildCreateSessionCommandValues — inline create claims are reclaimable', () => {
  const NOW = new Date('2026-09-24T12:00:00.000Z');
  const command: CreateSessionCommand = {
    ...BASE,
    project: { projectId: 'p', accountId: 'a' } as CreateSessionCommand['project'],
    idempotencyKey: 'create:key-1',
  };

  // The drain reclaims `status='running' AND locked_until <= now - grace`. A
  // NULL lock never satisfies that predicate, so an inline claim with no lock
  // answered `pending` for ever once its process died.
  test('an inline (running) claim carries a lock owner and an expiry', () => {
    const values = buildCreateSessionCommandValues(command, { initialStatus: 'running' }, NOW);
    expect(values.status).toBe('running');
    expect(values.lockedBy).toStartWith('session-lifecycle-inline:');
    expect(values.lockedUntil?.getTime()).toBe(NOW.getTime() + LIFECYCLE_CLAIM_LOCK_MS);
  });

  test('each inline claim has its own lock owner, the fencing token of its writes', () => {
    const first = buildCreateSessionCommandValues(command, { initialStatus: 'running' }, NOW);
    const second = buildCreateSessionCommandValues(command, { initialStatus: 'running' }, NOW);
    expect(first.lockedBy).not.toBe(second.lockedBy);
  });

  test('the lock expires into the reclaim window, like a drained claim', () => {
    const values = buildCreateSessionCommandValues(command, { initialStatus: 'running' }, NOW);
    const reclaimAt = new Date(
      NOW.getTime() + LIFECYCLE_CLAIM_LOCK_MS + LIFECYCLE_RUNNING_RECLAIM_GRACE_MS,
    );
    const staleRunningBefore = reclaimAt.getTime() - LIFECYCLE_RUNNING_RECLAIM_GRACE_MS;
    expect(values.lockedUntil!.getTime() <= staleRunningBefore).toBe(true);
  });

  test('a queued claim stays unlocked, so the drain takes it immediately', () => {
    const values = buildCreateSessionCommandValues(command, { initialStatus: 'queued' }, NOW);
    expect(values.status).toBe('queued');
    expect('lockedBy' in values).toBe(false);
    expect('lockedUntil' in values).toBe(false);
  });
});
