import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { accountMembers, projectSessions, sessionSandboxes } from '@kortix/db';
import * as realProviders from '../../platform/providers';
import * as realSandboxReaper from '../../projects/sandbox-reaper';

type SandboxRow = { sandboxId: string; provider: string; externalId: string | null };

let sandboxRows: SandboxRow[] = [];
let sandboxQueryError: Error | null = null;
let ownedAccountRows: Array<{ accountId: string }> = [];
let ownedAccountsQueryError: Error | null = null;
let sandboxWhereArg: unknown = null;
let sessionUpdateWhereArg: unknown = null;
let sessionsSettled: Array<{ sessionId: string }> = [];
let sessionUpdateError: Error | null = null;

let stops: string[] = [];
let removes: string[] = [];
let stopErrorByExternal: Record<string, Error> = {};
let removeErrorByExternal: Record<string, Error> = {};
let providerAvailable = true;
let reconciledRemoved: string[] = [];
let reconciledStopped: string[] = [];
let removedReconcileErrorByExternal: Record<string, Error> = {};
let creditAccount: Record<string, unknown> | null = null;

/**
 * The fake keys off the drizzle table object handed to `.from()` / `.update()`,
 * so the two different SELECTs (owned accounts vs sandboxes) and the session
 * settle UPDATE are told apart by identity rather than by call order.
 */
mock.module('../../shared/db', () => ({
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: async (cond: unknown) => {
          if (table === accountMembers) {
            if (ownedAccountsQueryError) throw ownedAccountsQueryError;
            return ownedAccountRows;
          }
          sandboxWhereArg = cond;
          if (sandboxQueryError) throw sandboxQueryError;
          return sandboxRows;
        },
      }),
    }),
    update: (table: unknown) => ({
      set: () => ({
        where: (cond: unknown) => ({
          returning: async () => {
            if (table !== projectSessions) return [];
            sessionUpdateWhereArg = cond;
            if (sessionUpdateError) throw sessionUpdateError;
            return sessionsSettled;
          },
        }),
      }),
    }),
  },
}));

// Spread the real module: `mock.module` replaces it WHOLESALE, so a stub that
// lists exports by hand deletes every export it omits — the failure surfaces in
// whatever unrelated file imports the missing name next, attributed to no test.
mock.module('../../platform/providers', () => ({
  ...realProviders,
  tryGetProvider: (_name: string) =>
    providerAvailable
      ? {
          stop: async (externalId: string) => {
            stops.push(externalId);
            const err = stopErrorByExternal[externalId];
            if (err) throw err;
          },
          remove: async (externalId: string) => {
            removes.push(externalId);
            const err = removeErrorByExternal[externalId];
            if (err) throw err;
          },
        }
      : null,
}));

// Spread the real module: `mock.module` replaces it WHOLESALE, so a stub that
// lists exports by hand deletes every export it omits — the failure surfaces in
// whatever unrelated file imports the missing name next, attributed to no test.
mock.module('../../projects/sandbox-reaper', () => ({
  ...realSandboxReaper,
  isAlreadyNotRunning: (err: unknown) =>
    err instanceof Error && err.message.toLowerCase().includes('already stopped'),
  reconcileSandboxRemovedByExternalId: async (externalId: string) => {
    const err = removedReconcileErrorByExternal[externalId];
    if (err) throw err;
    reconciledRemoved.push(externalId);
    return true;
  },
  reconcileSandboxStoppedByExternalId: async (externalId: string) => {
    reconciledStopped.push(externalId);
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

const {
  deleteAccountImmediately,
  reclaimableAccountIds,
  RECLAIMABLE_SANDBOX_STATUSES,
  LIVE_SESSION_STATUSES,
} = await import('./account-deletion');

/**
 * Collect every primitive a drizzle condition tree carries, so a test can prove
 * which account ids and statuses actually reached the WHERE clause without
 * depending on drizzle's internal chunk shape.
 */
function conditionValues(node: unknown, seen = new Set<unknown>()): string[] {
  if (node == null) return [];
  if (typeof node === 'string') return [node];
  if (typeof node !== 'object') return [];
  if (seen.has(node)) return [];
  seen.add(node);
  const out: string[] = [];
  for (const value of Object.values(node as Record<string, unknown>)) {
    out.push(...conditionValues(value, seen));
  }
  return out;
}

beforeEach(() => {
  sandboxRows = [];
  sandboxQueryError = null;
  ownedAccountRows = [];
  ownedAccountsQueryError = null;
  sandboxWhereArg = null;
  sessionUpdateWhereArg = null;
  sessionsSettled = [];
  sessionUpdateError = null;
  stops = [];
  removes = [];
  stopErrorByExternal = {};
  removeErrorByExternal = {};
  providerAvailable = true;
  reconciledRemoved = [];
  reconciledStopped = [];
  removedReconcileErrorByExternal = {};
  creditAccount = null;
});

describe('reclaim status filters', () => {
  test('a box mid-provision or in error is reclaimable, a terminal one is not', () => {
    // `active` alone was the old filter. A box that died during provisioning or
    // whose last control-plane call errored still exists at the provider and
    // still bills — 47 of them survived the release-gate sweep that way.
    expect([...RECLAIMABLE_SANDBOX_STATUSES]).toEqual(['provisioning', 'active', 'error']);
    expect(RECLAIMABLE_SANDBOX_STATUSES).not.toContain('stopped');
    expect(RECLAIMABLE_SANDBOX_STATUSES).not.toContain('archived');
  });

  test('every non-terminal session status is settled', () => {
    expect([...LIVE_SESSION_STATUSES]).toEqual([
      'queued',
      'branching',
      'provisioning',
      'running',
    ]);
    for (const terminal of ['stopped', 'failed', 'completed']) {
      expect(LIVE_SESSION_STATUSES).not.toContain(terminal);
    }
  });
});

describe('reclaimableAccountIds', () => {
  test('without a user id it is just the resolved account', async () => {
    ownedAccountRows = [{ accountId: 'acct-2' }];
    expect(await reclaimableAccountIds('acct-1')).toEqual(['acct-1']);
  });

  test('with a user id it covers every account that user owns', async () => {
    ownedAccountRows = [{ accountId: 'acct-2' }, { accountId: 'acct-3' }];
    const ids = await reclaimableAccountIds('acct-1', 'user-1');
    expect(ids.sort()).toEqual(['acct-1', 'acct-2', 'acct-3']);
  });

  test('the resolved account is never duplicated', async () => {
    ownedAccountRows = [{ accountId: 'acct-1' }, { accountId: 'acct-2' }];
    expect((await reclaimableAccountIds('acct-1', 'user-1')).sort()).toEqual([
      'acct-1',
      'acct-2',
    ]);
  });

  test('a failed membership lookup degrades to the single account, never to none', async () => {
    ownedAccountsQueryError = new Error('connection terminated');
    expect(await reclaimableAccountIds('acct-1', 'user-1')).toEqual(['acct-1']);
  });
});

describe('deleteAccountImmediately — sandbox reclaim', () => {
  test('stops AND removes every reclaimable box across every account the user owns', async () => {
    // 2 accounts × 2 boxes. Before this change the sweep saw only acct-1's
    // boxes, because the route resolves the earliest-joined account and nothing
    // widened it.
    ownedAccountRows = [{ accountId: 'acct-2' }];
    sandboxRows = [
      { sandboxId: 'sb-1', provider: 'daytona', externalId: 'ext-1' },
      { sandboxId: 'sb-2', provider: 'daytona', externalId: 'ext-2' },
      { sandboxId: 'sb-3', provider: 'e2b', externalId: 'ext-3' },
      { sandboxId: 'sb-4', provider: 'platinum', externalId: 'ext-4' },
    ];

    await deleteAccountImmediately('acct-1', 'user-1');

    expect(stops.sort()).toEqual(['ext-1', 'ext-2', 'ext-3', 'ext-4']);
    expect(removes.sort()).toEqual(['ext-1', 'ext-2', 'ext-3', 'ext-4']);
    // The removed reconcile is the one that revokes the session connector
    // token, which is what actually kills a surviving agent process.
    expect(reconciledRemoved.sort()).toEqual(['ext-1', 'ext-2', 'ext-3', 'ext-4']);
  });

  test('both owned accounts and every reclaimable status reach the sandbox query', async () => {
    ownedAccountRows = [{ accountId: 'acct-2' }];

    await deleteAccountImmediately('acct-1', 'user-1');

    const values = conditionValues(sandboxWhereArg);
    expect(values).toContain('acct-1');
    expect(values).toContain('acct-2');
    for (const status of RECLAIMABLE_SANDBOX_STATUSES) expect(values).toContain(status);
  });

  test('a box with no external id is skipped entirely', async () => {
    sandboxRows = [{ sandboxId: 'sb-1', provider: 'daytona', externalId: null }];

    await deleteAccountImmediately('acct-1');

    expect(stops).toEqual([]);
    expect(removes).toEqual([]);
    expect(reconciledRemoved).toEqual([]);
  });

  test('a stop failure on one box still removes it and never blocks the others', async () => {
    sandboxRows = [
      { sandboxId: 'sb-1', provider: 'daytona', externalId: 'ext-1' },
      { sandboxId: 'sb-2', provider: 'daytona', externalId: 'ext-2' },
    ];
    stopErrorByExternal['ext-1'] = new Error('provider unavailable');

    const result = await deleteAccountImmediately('acct-1');

    expect(result.success).toBe(true);
    expect(stops.sort()).toEqual(['ext-1', 'ext-2']);
    // A box we could not park is exactly the box that must not survive.
    expect(removes.sort()).toEqual(['ext-1', 'ext-2']);
    expect(reconciledRemoved.sort()).toEqual(['ext-1', 'ext-2']);
  });

  test('a remove failure on one box does not block the rest or the deletion', async () => {
    sandboxRows = [
      { sandboxId: 'sb-1', provider: 'daytona', externalId: 'ext-1' },
      { sandboxId: 'sb-2', provider: 'daytona', externalId: 'ext-2' },
    ];
    removeErrorByExternal['ext-1'] = new Error('provider 500');

    const result = await deleteAccountImmediately('acct-1');

    expect(result.success).toBe(true);
    expect(removes.sort()).toEqual(['ext-1', 'ext-2']);
    // The row is still settled, so nothing keeps billing against it.
    expect(reconciledRemoved.sort()).toEqual(['ext-1', 'ext-2']);
  });

  test('an already-gone box still stops, removes and reconciles cleanly', async () => {
    sandboxRows = [{ sandboxId: 'sb-1', provider: 'daytona', externalId: 'ext-1' }];
    stopErrorByExternal['ext-1'] = new Error('Sandbox already stopped');
    removeErrorByExternal['ext-1'] = new Error('Sandbox already stopped');

    await deleteAccountImmediately('acct-1');

    expect(reconciledRemoved).toEqual(['ext-1']);
  });

  test('a failed removed-reconcile falls back to the stopped reconcile', async () => {
    // The row must end terminal either way — an eternally `active` row keeps
    // billing and keeps the box eligible for a wake.
    sandboxRows = [{ sandboxId: 'sb-1', provider: 'daytona', externalId: 'ext-1' }];
    removedReconcileErrorByExternal['ext-1'] = new Error('deadlock detected');

    const result = await deleteAccountImmediately('acct-1');

    expect(result.success).toBe(true);
    expect(reconciledRemoved).toEqual([]);
    expect(reconciledStopped).toEqual(['ext-1']);
  });

  test('a provider with no configured client still settles the row', async () => {
    providerAvailable = false;
    sandboxRows = [{ sandboxId: 'sb-1', provider: 'daytona', externalId: 'ext-1' }];

    const result = await deleteAccountImmediately('acct-1');

    expect(result.success).toBe(true);
    expect(stops).toEqual([]);
    expect(reconciledRemoved).toEqual(['ext-1']);
  });

  test('a failure looking up the sandboxes does not block the deletion', async () => {
    sandboxQueryError = new Error('connection terminated');

    const result = await deleteAccountImmediately('acct-1');

    expect(result.success).toBe(true);
    expect(stops).toEqual([]);
  });

  test('no reclaimable sandboxes → no provider calls, deletion still succeeds', async () => {
    sandboxRows = [];

    const result = await deleteAccountImmediately('acct-1');

    expect(result.success).toBe(true);
    expect(stops).toEqual([]);
    expect(removes).toEqual([]);
  });
});

describe('deleteAccountImmediately — session settle', () => {
  test('every non-terminal session in every owned account is marked stopped', async () => {
    // These are the rows the manual playbook had to fix by hand: a session with
    // no sandbox row, or one whose row had no external id, stayed `running`
    // forever and the next preflight read it as live.
    ownedAccountRows = [{ accountId: 'acct-2' }];
    sessionsSettled = [{ sessionId: 's-1' }, { sessionId: 's-2' }];

    await deleteAccountImmediately('acct-1', 'user-1');

    const values = conditionValues(sessionUpdateWhereArg);
    expect(values).toContain('acct-1');
    expect(values).toContain('acct-2');
    for (const status of LIVE_SESSION_STATUSES) expect(values).toContain(status);
  });

  test('the sessions are settled even when the sandbox lookup failed', async () => {
    sandboxQueryError = new Error('connection terminated');
    sessionsSettled = [{ sessionId: 's-1' }];

    const result = await deleteAccountImmediately('acct-1');

    expect(result.success).toBe(true);
    expect(sessionUpdateWhereArg).not.toBeNull();
  });

  test('a failed session settle does not block the deletion', async () => {
    sessionUpdateError = new Error('deadlock detected');

    const result = await deleteAccountImmediately('acct-1');

    expect(result.success).toBe(true);
  });
});
