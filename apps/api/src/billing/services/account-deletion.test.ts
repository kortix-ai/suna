import { beforeEach, describe, expect, mock, test } from 'bun:test';

let sandboxRows: Array<{ sandboxId: string; provider: string; externalId: string | null }> = [];
let sandboxQueryError: Error | null = null;
let stops: string[] = [];
let stopErrorByExternal: Record<string, Error> = {};
let reconciled: string[] = [];
let creditAccount: Record<string, unknown> | null = null;

mock.module('../../shared/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: async () => {
          if (sandboxQueryError) throw sandboxQueryError;
          return sandboxRows;
        },
      }),
    }),
  },
}));

mock.module('../../platform/providers', () => ({
  getProvider: (_name: string) => ({
    stop: async (externalId: string) => {
      stops.push(externalId);
      const err = stopErrorByExternal[externalId];
      if (err) throw err;
    },
  }),
}));

mock.module('../../projects/sandbox-reaper', () => ({
  isAlreadyNotRunning: (err: unknown) =>
    err instanceof Error && err.message.toLowerCase().includes('already stopped'),
  reconcileSandboxStoppedByExternalId: async (externalId: string) => {
    reconciled.push(externalId);
    return true;
  },
}));

mock.module('../../shared/stripe', () => ({
  getStripe: () => ({
    subscriptions: { cancel: async () => undefined },
  }),
}));

mock.module('../repositories/credit-accounts', () => ({
  getCreditAccount: async () => creditAccount,
  updateCreditAccount: async () => undefined,
}));

mock.module('../repositories/transactions', () => ({
  insertLedgerEntry: async () => undefined,
}));

mock.module('../repositories/account-deletion', () => ({
  getActiveDeletionRequest: async () => null,
  createDeletionRequest: async () => ({ id: 'req-1' }),
  cancelDeletionRequest: async () => undefined,
  markDeletionCompleted: async () => undefined,
  getScheduledDeletions: async () => [],
}));

const { deleteAccountImmediately } = await import('./account-deletion');

beforeEach(() => {
  sandboxRows = [];
  sandboxQueryError = null;
  stops = [];
  stopErrorByExternal = {};
  reconciled = [];
  creditAccount = null;
});

describe('deleteAccountImmediately — sandbox teardown', () => {
  test('stops every active sandbox owned by the account and reconciles each', async () => {
    sandboxRows = [
      { sandboxId: 'sb-1', provider: 'daytona', externalId: 'ext-1' },
      { sandboxId: 'sb-2', provider: 'e2b', externalId: 'ext-2' },
    ];

    await deleteAccountImmediately('acct-1');

    expect(stops.sort()).toEqual(['ext-1', 'ext-2']);
    expect(reconciled.sort()).toEqual(['ext-1', 'ext-2']);
  });

  test('a box with no external id is skipped entirely', async () => {
    sandboxRows = [{ sandboxId: 'sb-1', provider: 'daytona', externalId: null }];

    await deleteAccountImmediately('acct-1');

    expect(stops).toEqual([]);
    expect(reconciled).toEqual([]);
  });

  test('a provider stop failure on one box does not block the rest or the deletion', async () => {
    sandboxRows = [
      { sandboxId: 'sb-1', provider: 'daytona', externalId: 'ext-1' },
      { sandboxId: 'sb-2', provider: 'daytona', externalId: 'ext-2' },
    ];
    stopErrorByExternal['ext-1'] = new Error('provider unavailable');

    const result = await deleteAccountImmediately('acct-1');

    expect(result.success).toBe(true);
    expect(stops.sort()).toEqual(['ext-1', 'ext-2']);
    expect(reconciled).toEqual(['ext-2']);
  });

  test('an already-stopped box still reconciles cleanly', async () => {
    sandboxRows = [{ sandboxId: 'sb-1', provider: 'daytona', externalId: 'ext-1' }];
    stopErrorByExternal['ext-1'] = new Error('Sandbox already stopped');

    await deleteAccountImmediately('acct-1');

    expect(reconciled).toEqual(['ext-1']);
  });

  test('a failure looking up the sandboxes does not block the deletion', async () => {
    sandboxQueryError = new Error('connection terminated');

    const result = await deleteAccountImmediately('acct-1');

    expect(result.success).toBe(true);
    expect(stops).toEqual([]);
  });

  test('no active sandboxes → no stop calls, deletion still succeeds', async () => {
    sandboxRows = [];

    const result = await deleteAccountImmediately('acct-1');

    expect(result.success).toBe(true);
    expect(stops).toEqual([]);
  });
});
