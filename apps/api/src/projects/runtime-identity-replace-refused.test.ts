/**
 * Rule 4 of the runtime-convergence contract: "a box that fails admission is
 * replaced, not used." `retireRefusedRuntime` is the replace half — it retires
 * an ESTABLISHED (externalId-bearing) box so the caller can allocate a fresh
 * one on the same session, instead of parking the session as `failed` the way
 * `preserveEstablishedRuntimeOnOpen` used to for this reason.
 *
 * Modeled on `runtime-identity-park-ledger.test.ts`'s harness: a database mock
 * that records which statements ran, inside or outside a transaction, and in
 * what order relative to the provider call.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import * as realComputeMetering from '../billing/services/compute-metering';
import * as realProviders from '../platform/providers';
import { mockConfigModule } from './reaping/test-support/mock-config';

let statements: Array<{ sql: string; inTransaction: boolean }> = [];
let sandboxClaims = 0;
let claimReleases = 0;
let deletes: Array<{ inTransaction: boolean }> = [];
let deleteReturnsEmpty = false;
let inTransaction = false;
let providerStops = 0;
let stopsInTransaction = 0;
let providerStopThrows: Error | null = null;
let computeEnds = 0;
let savepoints = 0;

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

mock.module('../lib/config', () => mockConfigModule());

const updater = () => ({
  set: () => ({
    where: () => ({
      returning: async () => {
        sandboxClaims += 1;
        return [{ sandboxId: 'sb-1' }];
      },
      // `releaseParkClaim` awaits `.where(...).catch(...)` directly, with no
      // `.returning()` in between.
      catch: async () => {
        claimReleases += 1;
      },
    }),
  }),
});

const deleter = () => ({
  where: () => ({
    returning: async () => {
      deletes.push({ inTransaction });
      return deleteReturnsEmpty ? [] : [{ sandboxId: 'sb-1' }];
    },
  }),
});

const executor = async (statement: unknown) => {
  statements.push({ sql: describeSql(statement), inTransaction });
};

const transactionScope: Record<string, unknown> = {
  update: updater,
  delete: deleter,
  execute: executor,
  transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
    savepoints += 1;
    return fn(transactionScope);
  },
};

mock.module('../lib/db', () => ({
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
    delete: deleter,
    execute: executor,
  },
}));

mock.module('../billing/services/compute-metering', () => ({
  ...realComputeMetering,
  endComputeSession: async () => {
    computeEnds += 1;
  },
  reopenComputeForSandbox: async () => undefined,
}));

mock.module('../platform/providers', () => ({
  ...realProviders,
  getProvider: () => ({
    stop: async () => {
      if (providerStopThrows) throw providerStopThrows;
      providerStops += 1;
      if (inTransaction) stopsInTransaction += 1;
    },
  }),
}));

const { retireRefusedRuntime } = await import('./runtime-identity');

const RUNNING_ROW = {
  sandboxId: 'sb-1',
  sessionId: 'sess-1',
  externalId: 'ext-1',
  status: 'active',
  metadata: {},
  provider: 'daytona',
  updatedAt: new Date('2026-09-27T00:00:00.000Z'),
};

beforeEach(() => {
  statements = [];
  sandboxClaims = 0;
  claimReleases = 0;
  deletes = [];
  deleteReturnsEmpty = false;
  inTransaction = false;
  providerStops = 0;
  stopsInTransaction = 0;
  providerStopThrows = null;
  computeEnds = 0;
  savepoints = 0;
});

describe('retireRefusedRuntime', () => {
  test('claims, stops the provider OUTSIDE any transaction, then settles + deletes INSIDE one', async () => {
    const ok = await retireRefusedRuntime(
      RUNNING_ROW as Parameters<typeof retireRefusedRuntime>[0],
      'runtime_admission_refused:catalog_fingerprint',
    );

    expect(ok).toBe(true);
    expect(sandboxClaims).toBe(1);
    expect(providerStops).toBe(1);
    expect(stopsInTransaction).toBe(0);
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.inTransaction).toBe(true);
    expect(computeEnds).toBe(1);
    // The turn ledger settles inside the same transaction as the delete.
    expect(statements).toHaveLength(1);
    expect(statements[0]?.inTransaction).toBe(true);
    expect(statements[0]?.sql).toContain('UPDATE kortix.session_turns');
    expect(statements[0]?.sql).toContain('runtime_gone');
  });

  test('a box holding live turn authority is never retired', async () => {
    const serving = {
      ...RUNNING_ROW,
      metadata: {
        activeTurns: { tok: { token: 'tok', state: 'active', opencodeSessionId: 'ses_1' } },
      },
    };

    const ok = await retireRefusedRuntime(
      serving as Parameters<typeof retireRefusedRuntime>[0],
      'runtime_admission_refused:catalog_fingerprint',
    );

    expect(ok).toBe(false);
    expect(sandboxClaims).toBe(0);
    expect(providerStops).toBe(0);
    expect(deletes).toHaveLength(0);
    expect(computeEnds).toBe(0);
  });

  test('a provider stop that genuinely fails leaves the row untouched', async () => {
    providerStopThrows = new Error('502 from provider control plane');

    const ok = await retireRefusedRuntime(
      RUNNING_ROW as Parameters<typeof retireRefusedRuntime>[0],
      'runtime_admission_refused:catalog_fingerprint',
    );

    expect(ok).toBe(false);
    // The claim is released; no delete, no ledger settle, no compute close.
    expect(deletes).toHaveLength(0);
    expect(statements).toEqual([]);
    expect(computeEnds).toBe(0);
    expect(sandboxClaims).toBe(1);
    expect(claimReleases).toBe(1);
  });

  test('a lost delete race (concurrent claim or deleted session) settles nothing', async () => {
    deleteReturnsEmpty = true;

    const ok = await retireRefusedRuntime(
      RUNNING_ROW as Parameters<typeof retireRefusedRuntime>[0],
      'runtime_admission_refused:catalog_fingerprint',
    );

    expect(ok).toBe(false);
    expect(statements).toEqual([]);
    expect(computeEnds).toBe(0);
  });
});
