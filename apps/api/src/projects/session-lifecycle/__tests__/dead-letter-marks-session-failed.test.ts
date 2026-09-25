// markCommandFailed() dead-letter path must be LOUD and must self-heal.
//
// The prod incident: a continue_session command exhausting its 5 attempts was
// dead-lettered with only a console.warn — invisible to Better Stack alerting
// — while the target session kept showing "queued — agent picking up" forever,
// and (worse) `session_mode = "reuse"` kept re-aiming every subsequent trigger
// fire at the same wedged session. These tests pin the two-part fix:
//   1. a dead-letter ships a REAL structured error through the logger, and
//   2. a continue_session dead-letter parks the target session 'failed' (with
//      a status re-check in the UPDATE predicate) so findReusableTriggerSession
//      skips it and the next fire creates a fresh session — the lossless
//      self-heal.
//
// Mocks `../../shared/db` and `../../lib/logger` via `mock.module` — which is
// process-global in bun:test, so run this file in its own `bun test <file>`
// invocation (as CI does), same caveat as ../../sandbox-reaper.test.ts.
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { projectSessions, projectTriggerRuntime, sessionLifecycleCommands } from '@kortix/db';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

/** The claim the writes below hold: the row is `running` under this owner. */
const LEASE = { commandId: 'cmd-1', lockedBy: 'worker-1' };

let commandRow: Record<string, unknown> | null = null;
let updateCalls: Array<{ table: unknown; updates: Record<string, unknown> }> = [];
let insertCalls: Array<{ table: unknown; values: Record<string, unknown> }> = [];
let errorLogs: Array<{ message: string; context?: Record<string, unknown> }> = [];

mock.module('../../../lib/logger', () => ({
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (message: string, context?: Record<string, unknown>) => {
      errorLogs.push({ message, context });
    },
  },
}));

mock.module('../../../shared/db', () => ({
  db: {
    update: (table: unknown) => ({
      set: (updates: Record<string, unknown>) => ({
        // Awaitable (the projectSessions park) AND chainable to `.returning()`
        // (the sessionLifecycleCommands mark). Records one call either way.
        where: () => {
          const record = () => updateCalls.push({ table, updates });
          return {
            then: (resolve: (v: unknown) => void) => {
              record();
              resolve(undefined);
            },
            returning: async () => {
              record();
              return commandRow ? [commandRow] : [];
            },
          };
        },
      }),
    }),
    // Awaitable insert + `.onConflictDoUpdate()` — used by
    // markTriggerRuntimeDeliveryFailed to flip projectTriggerRuntime to 'failed'.
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoUpdate: () => ({
          then: (resolve: (v: unknown) => void) => {
            insertCalls.push({ table, values });
            resolve(undefined);
          },
        }),
      }),
    }),
  },
}));

const { markCommandFailed } = await import('../store');

const baseCommandRow = (overrides: Record<string, unknown> = {}) => ({
  commandId: 'cmd-1',
  commandType: 'continue_session',
  source: 'trigger:cron',
  status: 'dead_lettered',
  projectId: 'proj-1',
  accountId: 'acct-1',
  sessionId: 'sess-1',
  idempotencyKey: 'trigger:cron:proj-1:daily:2026-07-21T00:00:00.000Z',
  payload: { text: 'run the report', triggerSlug: 'daily' },
  attempts: 5,
  ...overrides,
});

beforeEach(() => {
  commandRow = null;
  updateCalls = [];
  insertCalls = [];
  errorLogs = [];
});

describe('markCommandFailed — dead-letter is loud and parks the session', () => {
  test('continue_session exhausting retries ships an error and marks the session failed', async () => {
    commandRow = baseCommandRow();

    await markCommandFailed(LEASE, 'delivery outcome: pending', {
      retryable: true,
      attempts: 5,
      sessionId: 'sess-1',
    });

    expect(errorLogs).toHaveLength(1);
    expect(errorLogs[0].message).toContain('dead-lettered');
    expect(errorLogs[0].context).toMatchObject({
      command_id: 'cmd-1',
      command_type: 'continue_session',
      session_id: 'sess-1',
      project_id: 'proj-1',
      trigger_slug: 'daily',
      attempts: 5,
      error: 'delivery outcome: pending',
    });

    const sessionUpdates = updateCalls.filter((u) => u.table === projectSessions);
    expect(sessionUpdates).toHaveLength(1);
    expect(sessionUpdates[0].updates.status).toBe('failed');
    expect(String(sessionUpdates[0].updates.error)).toContain('dead-lettered');

    // The dead-letter now also surfaces on the trigger runtime row (last_status
    // 'failed' + error) so the triggers API/UI stops showing a frozen 'queued'.
    const runtimeInserts = insertCalls.filter((c) => c.table === projectTriggerRuntime);
    expect(runtimeInserts).toHaveLength(1);
    expect(runtimeInserts[0].values).toMatchObject({
      projectId: 'proj-1',
      slug: 'daily',
      lastStatus: 'failed',
    });
    expect(String(runtimeInserts[0].values.lastError)).toContain('delivery outcome: pending');
  });

  test('a dead-letter without a trigger slug parks the session but does not touch the runtime row', async () => {
    commandRow = baseCommandRow({ payload: { text: 'run the report' } });

    await markCommandFailed(LEASE, 'delivery outcome: no-session', {
      retryable: false,
      attempts: 1,
      sessionId: 'sess-1',
    });

    expect(updateCalls.filter((u) => u.table === projectSessions)).toHaveLength(1);
    expect(insertCalls.filter((c) => c.table === projectTriggerRuntime)).toHaveLength(0);
  });

  test('non-retryable failure dead-letters on the first attempt', async () => {
    commandRow = baseCommandRow({ attempts: 1 });

    await markCommandFailed(LEASE, 'delivery outcome: no-session', {
      retryable: false,
      attempts: 1,
      sessionId: 'sess-1',
    });

    expect(errorLogs).toHaveLength(1);
    expect(updateCalls.filter((u) => u.table === projectSessions)).toHaveLength(1);
  });

  test('a retryable failure below the attempt cap only requeues — no error, no park', async () => {
    commandRow = baseCommandRow({ status: 'queued', attempts: 2 });

    await markCommandFailed(LEASE, 'delivery outcome: pending', {
      retryable: true,
      attempts: 2,
      sessionId: 'sess-1',
    });

    expect(errorLogs).toHaveLength(0);
    expect(updateCalls.filter((u) => u.table === projectSessions)).toHaveLength(0);
    // The command row itself was still marked (back to queued with backoff).
    expect(updateCalls.filter((u) => u.table === sessionLifecycleCommands)).toHaveLength(1);
  });

  test('a create_session dead-letter ships the error but never touches a session row', async () => {
    commandRow = baseCommandRow({ commandType: 'create_session', sessionId: null, payload: {} });

    await markCommandFailed(LEASE, 'Project not found', { retryable: false, attempts: 1 });

    expect(errorLogs).toHaveLength(1);
    expect(errorLogs[0].context).toMatchObject({ command_type: 'create_session' });
    expect(updateCalls.filter((u) => u.table === projectSessions)).toHaveLength(0);
  });
});

describe('markCommandFailed — a dead-letter records WHY as a stable code', () => {
  const commandUpdate = () => {
    const updates = updateCalls.filter((u) => u.table === sessionLifecycleCommands);
    expect(updates).toHaveLength(1);
    return updates[0].updates;
  };
  const compiled = (value: unknown) => {
    expect(value).toBeDefined();
    const q = new PgDialect().sqlToQuery(value as SQL);
    return { sql: q.sql.replace(/\s+/g, ' ').trim(), params: q.params };
  };

  test('the producer\'s code is MERGED into result, so the row keeps its other markers', async () => {
    commandRow = baseCommandRow({ source: 'ui', payload: { text: 'hi', clientMessageId: 'q_1' } });

    await markCommandFailed(LEASE, 'prompt accepted by the runtime but never became a message', {
      retryable: false,
      attempts: 1,
      sessionId: 'sess-1',
      failureCode: 'not_landed',
    });

    const { sql, params } = compiled(commandUpdate().result);
    expect(sql).toBe(
      'COALESCE("kortix"."session_lifecycle_commands"."result", \'{}\'::jsonb) || $1::jsonb',
    );
    expect(params).toEqual(['{"failure_code":"not_landed"}']);
    expect(commandUpdate().status).toBe('dead_lettered');
    expect(errorLogs[0].context).toMatchObject({ failure_code: 'not_landed' });
  });

  test('a producer that does not know the cause records `unknown`', async () => {
    commandRow = baseCommandRow({ payload: { text: 'hi', clientMessageId: 'q_1' } });

    await markCommandFailed(LEASE, 'continue_session command missing sessionId or body', {
      retryable: false,
      attempts: 0,
    });

    expect(compiled(commandUpdate().result).params).toEqual(['{"failure_code":"unknown"}']);
  });

  test('a dead-letter that REPLACES result carries the code in the replacement', async () => {
    commandRow = baseCommandRow({ commandType: 'create_session', sessionId: 'sess-1', payload: {} });
    const result = { status: 'created', session_id: 'sess-1', source: 'ui', post_create_error: 'boom' };

    await markCommandFailed(LEASE, 'boom', { retryable: true, attempts: 5, sessionId: 'sess-1', result });

    expect(commandUpdate().result).toEqual({ ...result, failure_code: 'unknown' });
  });

  test('a failure that is only re-queued records no code', async () => {
    commandRow = baseCommandRow({ status: 'queued', attempts: 2 });

    await markCommandFailed(LEASE, 'the session was not ready in time', {
      retryable: true,
      attempts: 2,
      sessionId: 'sess-1',
      failureCode: 'runtime_unreachable',
    });
    expect(commandUpdate()).not.toHaveProperty('result');

    updateCalls = [];
    const result = { status: 'created', session_id: 'sess-1' };
    await markCommandFailed(LEASE, 'boom', { retryable: true, attempts: 2, result, failureCode: 'refused' });
    expect(commandUpdate().result).toEqual(result);
  });
});
