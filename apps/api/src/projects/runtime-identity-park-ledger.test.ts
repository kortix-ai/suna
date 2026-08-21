/**
 * The two parks that are NOT applyStoppedState.
 *
 * `preserveEstablishedRuntime` (the provider says the box is gone) and
 * `parkEstablishedRuntime` (stop it and leave it wakeable) both flip a row to
 * `stopped` in their own transaction. Every token-scoped `session_turns` settle
 * requires an `active`/`provisioning` row, so after either of them commits
 * nothing can ever close a turn that was still open — the row would claim a
 * turn is running for ever. These tests pin the settle into those two
 * transactions.
 *
 * `runtime-identity.test.ts` stays pure-function only; this file carries the
 * database mock so that suite keeps needing no harness.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { projectSessions, sessionSandboxes } from '@kortix/db';
import * as realComputeMetering from '../billing/services/compute-metering';
import * as realProviders from '../platform/providers';
import { mockConfigModule } from './reaping/test-support/mock-config';

let statements: Array<{ sql: string; inTransaction: boolean }> = [];
let sandboxUpdates = 0;
let inTransaction = false;
let liveSession = true;
let savepoints = 0;
/** When set, every `tx.execute` fails with this message. */
let executeThrows: string | null = null;

function describeSql(expression: unknown): string {
  const chunks = (expression as { queryChunks?: unknown[] } | null)?.queryChunks ?? [];
  return chunks
    .map((chunk) => {
      if (typeof chunk === 'string') return chunk;
      if (!chunk || typeof chunk !== 'object') return '';
      const value = (chunk as { value?: unknown }).value;
      if (Array.isArray(value)) return value.join('');
      if (typeof value === 'string') return value;
      return (chunk as { name?: string }).name ?? '';
    })
    .join(' ');
}

mock.module('../config', () => mockConfigModule());

const updater = (table: unknown) => ({
  set: () => ({
    where: () => ({
      returning: async () => {
        if (table === projectSessions) return liveSession ? [{ sessionId: 'sess-1' }] : [];
        sandboxUpdates += 1;
        return [{ sandboxId: 'sb-1', sessionId: 'sess-1' }];
      },
    }),
  }),
});

const executor = async (statement: unknown) => {
  statements.push({ sql: describeSql(statement), inTransaction });
  if (executeThrows) throw new Error(executeThrows);
};

// A nested drizzle transaction is a SAVEPOINT: the settle rides inside one so a
// ledger failure cannot abort a park whose provider box is already stopped.
const transactionScope: Record<string, unknown> = {
  update: updater,
  execute: executor,
  transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
    savepoints += 1;
    return fn(transactionScope);
  },
};

mock.module('../shared/db', () => ({
  db: {
    transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      inTransaction = true;
      try {
        return await fn(transactionScope);
      } finally {
        inTransaction = false;
      }
    },
    update: updater,
    execute: executor,
  },
}));

// Spread the real module: `mock.module` replaces it WHOLESALE, so a stub that
// lists exports by hand deletes every export it omits.
mock.module('../billing/services/compute-metering', () => ({
  ...realComputeMetering,
  endComputeSession: async () => {},
  reopenComputeForSandbox: async () => undefined,
}));

mock.module('../platform/providers', () => ({
  ...realProviders,
  getProvider: () => ({ stop: async () => {} }),
}));

const { parkEstablishedRuntime, preserveEstablishedRuntime } = await import('./runtime-identity');

const ROW = {
  sandboxId: 'sb-1',
  sessionId: 'sess-1',
  externalId: 'ext-1',
  metadata: {
    activeTurns: {
      'open-token': { token: 'open-token', state: 'active', opencodeSessionId: 'ses_root' },
    },
  },
  provider: 'daytona',
};

beforeEach(() => {
  statements = [];
  sandboxUpdates = 0;
  inTransaction = false;
  liveSession = true;
  savepoints = 0;
  executeThrows = null;
});

describe('parks outside applyStoppedState settle the turn ledger', () => {
  test('preserveEstablishedRuntime settles open turns as runtime_gone, in its transaction', async () => {
    await preserveEstablishedRuntime(ROW, 'provider_webhook_removed', 'provider_removed');

    expect(sandboxUpdates).toBe(1);
    expect(statements).toHaveLength(1);
    expect(statements[0]?.inTransaction).toBe(true);
    expect(statements[0]?.sql).toContain('UPDATE kortix.session_turns');
    expect(statements[0]?.sql).toContain('runtime_gone');
    expect(statements[0]?.sql).toContain('sb-1');
    expect(statements[0]?.sql).toContain("state <> 'ended'");
  });

  test('parkEstablishedRuntime settles open turns as runtime_gone, in its transaction', async () => {
    await parkEstablishedRuntime(
      ROW as Parameters<typeof parkEstablishedRuntime>[0],
      'opencode_ready_wait_stale',
      'runtime_boot_failed',
    );

    expect(sandboxUpdates).toBe(1);
    expect(statements).toHaveLength(1);
    expect(statements[0]?.inTransaction).toBe(true);
    expect(statements[0]?.sql).toContain('UPDATE kortix.session_turns');
    expect(statements[0]?.sql).toContain('runtime_gone');
  });

  test('a park that loses the session CAS writes no ledger settle', async () => {
    liveSession = false;

    expect(await preserveEstablishedRuntime(ROW, 'provider_gone', 'provider_removed')).toBeNull();

    // Nothing was parked, so nothing ended.
    expect(sandboxUpdates).toBe(0);
    expect(statements).toEqual([]);
  });

  // Both parks stop the PROVIDER BOX before they open this transaction
  // (parkEstablishedRuntime calls provider.stop(); preserveEstablishedRuntime
  // runs because the provider already reports it gone). An abort here would
  // leave the row 'active' and the session 'running' against a dead box, and
  // every retry would fail the same way. The settle is savepoint-bounded so it
  // cannot do that.
  test('a ledger settle that throws leaves the park committed', async () => {
    executeThrows = 'canceling statement due to statement timeout';
    const error = console.error;
    console.error = () => {};
    try {
      expect(
        await parkEstablishedRuntime(
          ROW as Parameters<typeof parkEstablishedRuntime>[0],
          'opencode_ready_wait_stale',
          'runtime_boot_failed',
        ),
      ).not.toBeNull();
    } finally {
      console.error = error;
    }

    expect(sandboxUpdates).toBe(1);
    expect(savepoints).toBe(1);
  });

  test('each settle runs inside a savepoint of the park transaction', async () => {
    await preserveEstablishedRuntime(ROW, 'provider_webhook_removed', 'provider_removed');

    expect(savepoints).toBe(1);
  });
});
