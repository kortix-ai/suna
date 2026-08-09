import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { sessionLifecycleCommands } from '@kortix/db';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

let updateCalls: Array<{
  table: unknown;
  set: Record<string, unknown>;
  where: SQL;
}> = [];
let currentOwner = 'worker-b';
let currentAttempt = 2;

function isCurrentFence(where: SQL): boolean {
  const query = new PgDialect().sqlToQuery(where);
  return query.params.includes(currentOwner) && query.params.includes(currentAttempt);
}

const mockDb: any = {
  update: (table: unknown) => ({
    set: (values: Record<string, unknown>) => ({
      where: (where: SQL) => {
        updateCalls.push({ table, set: values, where });
        return {
          returning: async () =>
            isCurrentFence(where)
              ? [
                  {
                    commandId: 'cmd-1',
                    commandType: 'continue_session',
                    payload: {},
                  },
                ]
              : [],
        };
      },
    }),
  }),
};
mockDb.transaction = async (callback: (tx: typeof mockDb) => unknown) => callback(mockDb);
mock.module('../../../shared/db', () => ({ db: mockDb }));

mock.module('../../../lib/logger', () => ({
  logger: { debug() {}, info() {}, warn() {}, error() {} },
}));

const {
  LIFECYCLE_COMMAND_LEASE_MS,
  lifecycleCommandClaim,
  markCommandFailed,
  markCommandSucceeded,
  renewLifecycleCommandLease,
} = await import('../store');

beforeEach(() => {
  updateCalls = [];
  currentOwner = 'worker-b';
  currentAttempt = 2;
});

describe('lifecycle command claim fencing', () => {
  test('lease covers the 5 minute readiness wait plus 45 second prompt delivery window', () => {
    expect(LIFECYCLE_COMMAND_LEASE_MS).toBeGreaterThanOrEqual(5 * 60_000 + 45_000);
  });

  test('a stale worker cannot overwrite success after another worker reclaims the command', async () => {
    const stale = { lockedBy: 'worker-a', attempt: 1 };
    const current = { lockedBy: 'worker-b', attempt: 2 };

    expect(await markCommandSucceeded('cmd-1', { status: 'delivered' }, 'sess-1', stale)).toBe(
      false,
    );
    expect(await markCommandSucceeded('cmd-1', { status: 'delivered' }, 'sess-1', current)).toBe(
      true,
    );

    for (const call of updateCalls) {
      if (call.table !== sessionLifecycleCommands) continue;
      const { sql, params } = new PgDialect().sqlToQuery(call.where);
      expect(sql).toContain('"status" =');
      expect(sql).toContain('"locked_by" =');
      expect(sql).toContain('"attempts" =');
      expect(params).toContain(call === updateCalls[0] ? 'worker-a' : 'worker-b');
    }
  });

  test('a stale failure cannot requeue or dead-letter a reclaimed command', async () => {
    const applied = await markCommandFailed('cmd-1', 'late timeout', {
      retryable: true,
      attempts: 1,
      claim: { lockedBy: 'worker-a', attempt: 1 },
    });

    expect(applied).toBe(false);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].set.status).toBe('queued');
  });

  test('only the current claim can heartbeat and extend its lease', async () => {
    const now = new Date('2026-08-07T00:00:00.000Z');
    expect(
      await renewLifecycleCommandLease('cmd-1', { lockedBy: 'worker-a', attempt: 1 }, now),
    ).toBe(false);
    expect(
      await renewLifecycleCommandLease('cmd-1', { lockedBy: 'worker-b', attempt: 2 }, now),
    ).toBe(true);
    expect(updateCalls[1].set.lockedUntil).toEqual(
      new Date(now.getTime() + LIFECYCLE_COMMAND_LEASE_MS),
    );
  });

  test('claimed rows expose lockedBy plus attempt as the immutable claim token', () => {
    expect(lifecycleCommandClaim({ lockedBy: 'worker-b', attempts: 2 })).toEqual({
      lockedBy: 'worker-b',
      attempt: 2,
    });
    expect(() => lifecycleCommandClaim({ lockedBy: null, attempts: 2 })).toThrow(
      'missing lock owner',
    );
  });
});
