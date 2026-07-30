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
import { projectSessions, sessionLifecycleCommands } from '@kortix/db';

let commandRow: Record<string, unknown> | null = null;
let updateCalls: Array<{ table: unknown; updates: Record<string, unknown> }> = [];
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
  errorLogs = [];
});

describe('markCommandFailed — dead-letter is loud and parks the session', () => {
  test('continue_session exhausting retries ships an error and marks the session failed', async () => {
    commandRow = baseCommandRow();

    await markCommandFailed('cmd-1', 'delivery outcome: pending', {
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
  });

  test('non-retryable failure dead-letters on the first attempt', async () => {
    commandRow = baseCommandRow({ attempts: 1 });

    await markCommandFailed('cmd-1', 'delivery outcome: no-session', {
      retryable: false,
      attempts: 1,
      sessionId: 'sess-1',
    });

    expect(errorLogs).toHaveLength(1);
    expect(updateCalls.filter((u) => u.table === projectSessions)).toHaveLength(1);
  });

  test('a retryable failure below the attempt cap only requeues — no error, no park', async () => {
    commandRow = baseCommandRow({ status: 'queued', attempts: 2 });

    await markCommandFailed('cmd-1', 'delivery outcome: pending', {
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

    await markCommandFailed('cmd-1', 'Project not found', { retryable: false, attempts: 1 });

    expect(errorLogs).toHaveLength(1);
    expect(errorLogs[0].context).toMatchObject({ command_type: 'create_session' });
    expect(updateCalls.filter((u) => u.table === projectSessions)).toHaveLength(0);
  });
});
