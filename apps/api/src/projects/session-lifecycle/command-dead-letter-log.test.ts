// The dead-letter warn for an EXPECTED customer-state refusal is SAMPLED
// (KRTX-4017): one cron trigger firing every ~100 s into an account that
// cannot pay logged ~36 warns/h — every fire dead-letters on attempt 1 with
// no retry, and each one logged. The first reports, then at most one per
// interval; a platform dead-letter keeps its per-occurrence error. The
// suppression never touches the row: every call still dead-letters.
//
// `mock.module` is process-global in bun:test; this file runs on its own
// under `--isolate`.
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { SessionLifecycleCommandRow } from './store';

// The only mock the rig needs: with `payload = {}` a dead-lettered
// `create_session` row reaches no other collaborator — no trigger slug to
// alert, no postCreate claims to release, no session to park.
let returning: SessionLifecycleCommandRow[] = [];
mock.module('../../shared/db', () => ({
  withDbTransaction: <T,>(action: () => Promise<T>): Promise<T> => action(),
  hasDatabase: () => true,
  db: {
    update: () => ({
      set: () => ({
        where: () => ({
          returning: async () => returning,
        }),
      }),
    }),
  },
}));

const {
  markCommandFailed,
  __resetCustomerStateDeadLetterSamplerForTests,
  customerStateDeadLetterShouldLog,
} = await import('./command-transitions');
const { logger } = await import('../../lib/logger');

const OUT_OF_CREDITS = 'Out of credits. Top up to continue.';
const PLATFORM = 'delivery outcome: pending';

function row(overrides: Partial<SessionLifecycleCommandRow> = {}): SessionLifecycleCommandRow {
  const now = new Date();
  return {
    commandId: 'cmd-1',
    commandType: 'create_session',
    source: 'trigger:cron',
    status: 'running',
    projectId: 'proj-1',
    sessionId: null,
    accountId: 'acct-1',
    actorUserId: null,
    idempotencyKey: null,
    payload: {},
    result: {},
    attempts: 1,
    availableAt: now,
    lockedBy: 'worker-x',
    lockedUntil: new Date(now.getTime() + 5 * 60_000),
    lastError: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as SessionLifecycleCommandRow;
}

const lease = { commandId: 'cmd-1', lockedBy: 'worker-x' };

let warn: ReturnType<typeof mock>;
let error: ReturnType<typeof mock>;
let origWarn: typeof logger.warn;
let origError: typeof logger.error;

beforeEach(() => {
  __resetCustomerStateDeadLetterSamplerForTests();
  returning = [row({ status: 'dead_lettered' })];
  warn = mock(() => {});
  error = mock(() => {});
  origWarn = logger.warn;
  origError = logger.error;
  logger.warn = warn as unknown as typeof logger.warn;
  logger.error = error as unknown as typeof logger.error;
});

afterEach(() => {
  logger.warn = origWarn;
  logger.error = origError;
});

describe('markCommandFailed dead-letter logging (KRTX-4017)', () => {
  test('the first out-of-credits dead-letter warns; repeats in the window stay silent', async () => {
    for (let i = 0; i < 3; i += 1) {
      const outcome = await markCommandFailed(lease, OUT_OF_CREDITS, { retryable: false, attempts: 1 });
      expect(outcome).toBe('dead_lettered');
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  });

  test('a platform dead-letter is never sampled: one error per occurrence', async () => {
    for (let i = 0; i < 3; i += 1) {
      await markCommandFailed(lease, PLATFORM, { retryable: false, attempts: 1 });
    }
    expect(error).toHaveBeenCalledTimes(3);
    expect(warn).not.toHaveBeenCalled();
  });

  test('the sampled line carries the dead-letter fields', async () => {
    await markCommandFailed(lease, OUT_OF_CREDITS, { retryable: false, attempts: 1 });
    expect(warn).toHaveBeenCalledWith(
      '[session-lifecycle] command dead-lettered — giving up after retries',
      expect.objectContaining({
        cause: 'customer_state',
        command_type: 'create_session',
        source: 'trigger:cron',
        attempts: 1,
        error: OUT_OF_CREDITS,
      }),
    );
  });
});

describe('customerStateDeadLetterShouldLog', () => {
  test('the window re-opens one interval after the last line', () => {
    __resetCustomerStateDeadLetterSamplerForTests();
    // A real clock is hours past the sampler's zero, and the first line must
    // log: pick t0 an hour past it.
    const t0 = 3_600_000;
    expect(customerStateDeadLetterShouldLog(t0)).toBe(true);
    expect(customerStateDeadLetterShouldLog(t0 + 1)).toBe(false);
    // 30 min window, matching CUSTOMER_STATE_DEAD_LETTER_LOG_INTERVAL_MS.
    expect(customerStateDeadLetterShouldLog(t0 + 1_799_999)).toBe(false);
    expect(customerStateDeadLetterShouldLog(t0 + 1_800_000)).toBe(true);
  });
});
