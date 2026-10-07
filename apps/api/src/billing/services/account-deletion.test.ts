import { beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  accountDeletionRequests,
  accountMembers,
  accounts,
  appDeploymentEvents,
  appDeployments,
  changeRequests,
  connectorCalls,
  connectorConnections,
  gatewayRequestLogs,
  impersonationGrants,
  kortixApiKeys,
  legacySandboxMigrations,
  platformUserRoles,
  projectSessions,
  projectSessionConnectorBindings,
  projectTriggerExecutions,
  projectTriggerRuntime,
  projects,
  providerEvents,
  reviewItems,
  sandboxes,
  sandboxComputeSessions,
  sessionLifecycleCommands,
  sessionPendingQuestions,
  sessionSandboxes,
  sessionTurns,
  sunaAccountMigrations,
  tunnelAuditLogs,
  tunnelConnections,
  tunnelDeviceAuthRequests,
  usageEvents,
} from '@kortix/db';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import * as realProviders from '../../platform/providers';
import * as realSandboxReaper from '../../projects/sandbox-reaper';

/**
 * Every table the deletion must sweep that the accounts-row cascade cannot
 * reach: the pure orphans (an `account_id` column with no foreign key) plus
 * the child rows whose non-cascading FK edges (NO ACTION / RESTRICT) would
 * abort the cascade. Kept in the TEST, not imported from the service: a new
 * orphan table fails this list until its author decides where it belongs.
 */
const ORPHAN_ACCOUNT_TABLES = [
  accountDeletionRequests,
  appDeploymentEvents,
  appDeployments,
  changeRequests,
  connectorConnections,
  impersonationGrants,
  kortixApiKeys,
  legacySandboxMigrations,
  platformUserRoles,
  projectSessionConnectorBindings,
  projectTriggerExecutions,
  projectTriggerRuntime,
  providerEvents,
  reviewItems,
  sandboxes,
  sessionSandboxes,
  sunaAccountMigrations,
  tunnelAuditLogs,
  tunnelConnections,
  tunnelDeviceAuthRequests,
];

/**
 * The sweeps scoped through a subquery of the account's project / session /
 * app ids instead of an account_id column: those tables have no account_id
 * index to drive the delete, so the sweep follows the parent ids.
 */
const SUBQUERY_SCOPED_TABLES = new Set<unknown>([
  appDeploymentEvents,
  appDeployments,
  projectTriggerExecutions,
  projectTriggerRuntime,
  reviewItems,
  sessionPendingQuestions,
  sessionTurns,
]);

type SandboxRow = { sandboxId: string; provider: string; externalId: string | null };

let sandboxRows: SandboxRow[] = [];
let sandboxQueryError: Error | null = null;
let ownedAccountRows: Array<{ accountId: string }> = [];
let ownedAccountsQueryError: Error | null = null;
let ownedAccountsWhereArg: unknown = null;
let sandboxWhereArg: unknown = null;
let sessionUpdateWhereArg: unknown = null;
let sessionsSettled: Array<{ sessionId: string }> = [];
let sessionUpdateError: Error | null = null;

let deletedRows: Array<{ table: unknown; condition: unknown }> = [];
let chunkDeleteStatements = 0;
let deleteError: Error | null = null;

let stops: string[] = [];
let removes: string[] = [];
let stopErrorByExternal: Record<string, Error> = {};
let removeErrorByExternal: Record<string, Error> = {};
let providerAvailable = true;
let reconciledRemoved: string[] = [];
let reconciledStopped: string[] = [];
let removedReconcileErrorByExternal: Record<string, Error> = {};
let creditAccount: Record<string, unknown> | null = null;
let activeRequest: { id: string; userId: string } | null = null;
let scheduledRequests: Array<{ id: string; accountId: string; userId: string }> = [];
let completedRequests: string[] = [];
let deletedUsers: string[] = [];
let deleteUserError: Error | null = null;
const { config } = await import('../../config');
config.SUPABASE_JWT_LIVENESS_TTL_MS = 30000;
const liveness = await import('../../shared/jwt-liveness');
mock.module('../../shared/supabase', () => ({
  getSupabase: () => ({ auth: { admin: { deleteUser: async (id: string) => {
    if (deleteUserError) return { error: deleteUserError };
    deletedUsers.push(id);
    return { error: null };
  } } } }),
}));

/**
 * The fake keys off the drizzle table object handed to `.from()` / `.update()`,
 * so the two different SELECTs (owned accounts vs sandboxes) and the session
 * settle UPDATE are told apart by identity rather than by call order.
 */
mock.module('../../shared/db', () => {
  interface FakeDb {
    select: () => {
      from: (table: unknown) => {
        where: (cond: unknown) => Promise<unknown[]>;
      };
    };
    update: (table: unknown) => {
      set: () => {
        where: (cond: unknown) => {
          returning: () => Promise<unknown[]>;
        };
      };
    };
    delete: (table: unknown) => {
      where: (cond: unknown) => Promise<{ rowCount: number }>;
    };
    transaction: <T>(fn: (tx: FakeDb) => Promise<T>) => Promise<T>;
    execute: (query: unknown) => Promise<Array<{ n: number }>>;
  }
  const db: FakeDb = {
    select: () => ({
      from: (table: unknown) => ({
        where: async (cond: unknown) => {
          if (table === accountMembers) {
            ownedAccountsWhereArg = cond;
            if (ownedAccountsQueryError) throw ownedAccountsQueryError;
            return ownedAccountRows;
          }
          if (table === sessionSandboxes) {
            sandboxWhereArg = cond;
            if (sandboxQueryError) throw sandboxQueryError;
            return sandboxRows;
          }
          // Subquery scopes built inside the deletion transaction (projects,
          // apps, deployments, sessions) resolve to no rows by default; the
          // tests that need rows set them explicitly.
          return [];
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
    delete: (table: unknown) => ({
      where: async (cond: unknown) => {
        deletedRows.push({ table, condition: cond });
        if (deleteError) throw deleteError;
        return { rowCount: 1 };
      },
    }),
    // The fake has no real transaction semantics: the callback runs against
    // the same fake, which is exactly what the tests assert about (the sweep
    // statements issued inside one transaction).
    transaction: <T,>(fn: (tx: FakeDb) => Promise<T>): Promise<T> => fn(db),
    // The bounded chunk deletes run outside the transaction as raw SQL; their
    // real behavior is covered by integration-account-deletion.test.ts.
    execute: async () => {
      chunkDeleteStatements++;
      if (deleteError) throw deleteError;
      return [{ n: 0 }];
    },
  };
  return { db };
});

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

mock.module('../wallet', () => ({
  wallet: { forfeit: async () => undefined },
}));

mock.module('../repositories/account-deletion', () => ({
  getActiveDeletionRequest: async () => activeRequest,
  createDeletionRequest: async () => ({ id: 'req-1' }),
  cancelDeletionRequest: async () => undefined,
  markDeletionCompleted: async (id: string) => { completedRequests.push(id); },
  countOverdueBacklog: async () => 0,
  getScheduledDeletions: async () => scheduledRequests,
  claimDeletionRequest: async (id: string) => scheduledRequests.find((r: { id: string }) => r.id === id) ?? null,
  releaseDeletionRequest: async () => undefined,
}));

const { deleteAccountImmediately, reclaimableAccountIds, processScheduledDeletions } = await import('./account-deletion');

/**
 * The bound parameters of a drizzle WHERE condition, in order, rendered by the
 * PostgreSQL dialect. A test proves which account ids and statuses reach the
 * query without depending on drizzle's internal chunk shape.
 */
const dialect = new PgDialect();
function whereParams(condition: unknown): unknown[] {
  return dialect.sqlToQuery(condition as SQL).params;
}

/** The WHERE condition the deletion swept `table` with. */
function swept(table: unknown): unknown {
  return deletedRows.find((d) => d.table === table)?.condition;
}

/** A user deleting their personal account: its id is the user id. */
const ME = 'user-1';

beforeEach(() => {
  sandboxRows = [];
  sandboxQueryError = null;
  ownedAccountRows = [];
  ownedAccountsQueryError = null;
  ownedAccountsWhereArg = null;
  sandboxWhereArg = null;
  sessionUpdateWhereArg = null;
  sessionsSettled = [];
  sessionUpdateError = null;
  deletedRows = [];
  chunkDeleteStatements = 0;
  deleteError = null;
  stops = [];
  removes = [];
  stopErrorByExternal = {};
  removeErrorByExternal = {};
  providerAvailable = true;
  reconciledRemoved = [];
  reconciledStopped = [];
  removedReconcileErrorByExternal = {};
  creditAccount = null;
  deletedUsers = [];
  activeRequest = null;
  scheduledRequests = [];
  completedRequests = [];
  deleteUserError = null;
  liveness.__setJwtLivenessLoaderForTests(null);
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
    // OWNED, not merely a member: deletion must never tear down the sandboxes
    // of a team the user only belongs to.
    const filter = whereParams(ownedAccountsWhereArg);
    expect(filter).toContain('user-1');
    expect(filter).toContain('owner');
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
    // 2 accounts × 2 boxes. Before this change the sweep saw only the personal
    // account's boxes, because the route resolves the earliest-joined account
    // and nothing widened it.
    ownedAccountRows = [{ accountId: 'acct-2' }];
    sandboxRows = [
      { sandboxId: 'sb-1', provider: 'daytona', externalId: 'ext-1' },
      { sandboxId: 'sb-2', provider: 'daytona', externalId: 'ext-2' },
      { sandboxId: 'sb-3', provider: 'e2b', externalId: 'ext-3' },
      { sandboxId: 'sb-4', provider: 'platinum', externalId: 'ext-4' },
    ];

    await deleteAccountImmediately(ME, ME);

    expect(stops.sort()).toEqual(['ext-1', 'ext-2', 'ext-3', 'ext-4']);
    expect(removes.sort()).toEqual(['ext-1', 'ext-2', 'ext-3', 'ext-4']);
    // The removed reconcile is the one that revokes the session connector
    // token, which is what actually kills a surviving agent process.
    expect(reconciledRemoved.sort()).toEqual(['ext-1', 'ext-2', 'ext-3', 'ext-4']);
  });

  test('both owned accounts and every reclaimable status reach the sandbox query', async () => {
    ownedAccountRows = [{ accountId: 'acct-2' }];

    await deleteAccountImmediately(ME, ME);

    const values = whereParams(sandboxWhereArg);
    expect(values).toContain(ME);
    expect(values).toContain('acct-2');
    // `active` alone was the old filter. A box that died during provisioning or
    // whose last control-plane call errored still exists at the provider and
    // still bills — 47 of them survived the release-gate sweep that way.
    for (const status of ['provisioning', 'active', 'error']) expect(values).toContain(status);
    for (const status of ['stopped', 'archived']) expect(values).not.toContain(status);
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

});

describe('deleteAccountImmediately — session settle', () => {
  test('every non-terminal session in every owned account is marked stopped', async () => {
    // These are the rows the manual playbook had to fix by hand: a session with
    // no sandbox row, or one whose row had no external id, stayed `running`
    // forever and the next preflight read it as live.
    ownedAccountRows = [{ accountId: 'acct-2' }];
    sessionsSettled = [{ sessionId: 's-1' }, { sessionId: 's-2' }];

    await deleteAccountImmediately(ME, ME);

    const values = whereParams(sessionUpdateWhereArg);
    expect(values).toContain(ME);
    expect(values).toContain('acct-2');
    for (const status of ['queued', 'branching', 'provisioning', 'running']) expect(values).toContain(status);
    for (const status of ['stopped', 'failed', 'completed']) expect(values).not.toContain(status);
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

describe('deleteAccountImmediately — account data deletion', () => {
  test('deletes the account row and sweeps every orphaned account-scoped table', async () => {
    await deleteAccountImmediately('acct-1', 'user-1');

    const swept = new Map<unknown, unknown>(deletedRows.map((d) => [d.table, d.condition]));
    // The account row itself is gone; the cascade takes every FK'd table.
    expect(swept.has(accounts)).toBe(true);
    expect(whereParams(swept.get(accounts))).toContain('acct-1');
    for (const table of ORPHAN_ACCOUNT_TABLES) {
      expect(swept.has(table)).toBe(true);
    }
    // The seven unbounded tables go in chunked statements outside the transaction.
    expect(chunkDeleteStatements).toBe(7);
    // Every account_id-bound sweep is bound to the deleting account. The
    // sweeps scoped through a subquery of the account's project/session/app
    // ids (these tables have no account_id index) are covered by the
    // integration suite against real PostgreSQL.
    for (const d of deletedRows) {
      if (SUBQUERY_SCOPED_TABLES.has(d.table)) continue;
      expect(whereParams(d.condition)).toContain('acct-1');
    }
  });

  test('the account data is deleted before the auth identity is dropped', async () => {
    await deleteAccountImmediately(ME, ME);

    // A failed sweep must not sign a user out of an account whose data
    // survived, so the data deletion completes before the identity goes.
    expect(deletedRows.length).toBeGreaterThan(0);
    expect(deletedUsers).toEqual([ME]);
  });

  test('a failed sweep aborts the deletion without dropping the auth identity', async () => {
    deleteError = new Error('sweep failed');

    await expect(deleteAccountImmediately(ME, ME)).rejects.toThrow('sweep failed');

    expect(deletedUsers).toEqual([]);
    expect(completedRequests).toEqual([]);
  });

  test('a pending request row is swept with the account data', async () => {
    activeRequest = { id: 'req-1', userId: ME };

    await deleteAccountImmediately(ME, ME);

    const swept = new Map<unknown, unknown>(deletedRows.map((d) => [d.table, d.condition]));
    expect(swept.has(accountDeletionRequests)).toBe(true);
    expect(deletedUsers).toEqual([ME]);
    expect(completedRequests).toEqual(['req-1']);
  });
});

describe('account deletion — auth lifecycle', () => {
  test('deletes the auth user and rejects all previously cached tokens promptly', async () => {
    liveness.__setJwtLivenessLoaderForTests(async () =>
      deletedUsers.includes(ME) ? null : { id: ME, email: '' });
    const exp = Math.floor(Date.now() / 1000) + 3600;
    expect(await liveness.confirmJwtLive('old-token-1', exp)).not.toBeNull();
    expect(await liveness.confirmJwtLive('old-token-2', exp)).not.toBeNull();
    await deleteAccountImmediately(ME, ME);
    expect(deletedUsers).toEqual([ME]);
    expect(await liveness.confirmJwtLive('old-token-1', exp)).toBeNull();
    expect(await liveness.confirmJwtLive('old-token-2', exp)).toBeNull();
  });

  test('does not report success when GoTrue refuses deletion', async () => {
    deleteUserError = new Error('auth deletion failed');
    await expect(deleteAccountImmediately(ME, ME)).rejects.toThrow('auth deletion failed');
  });
});

test('immediate deletion uses the pending requester when no user id is supplied', async () => {
  activeRequest = { id: 'req-1', userId: ME };
  await deleteAccountImmediately(ME);
  expect(deletedUsers).toEqual([ME]);
  expect(completedRequests).toEqual(['req-1']);
});

test('scheduled account deletion deletes the account data, then its requester identity', async () => {
  scheduledRequests = [{ id: 'req-1', accountId: ME, userId: ME }];
  expect(await processScheduledDeletions()).toEqual({ processed: 1, errors: [] });
  expect(deletedRows.length).toBeGreaterThan(0);
  expect(deletedUsers).toEqual([ME]);
  expect(completedRequests).toEqual(['req-1']);
});

test('failed auth deletion leaves the pending request incomplete', async () => {
  activeRequest = { id: 'req-1', userId: ME };
  deleteUserError = new Error('auth deletion failed');
  await expect(deleteAccountImmediately(ME)).rejects.toThrow('auth deletion failed');
  expect(completedRequests).toEqual([]);
});

// The requester's login goes only with their personal account (id == user id).
describe("deleting an account that is not the requester's personal account", () => {
  test('a team account the requester owns: data deleted, login and other accounts kept', async () => {
    ownedAccountRows = [{ accountId: ME }, { accountId: 'acct-2' }];
    sandboxRows = [{ sandboxId: 'sb-1', provider: 'daytona', externalId: 'ext-1' }];

    await deleteAccountImmediately('acct-1', ME);

    expect(whereParams(swept(accounts))).toContain('acct-1');
    expect(deletedUsers).toEqual([]);
    expect(whereParams(sandboxWhereArg)).toEqual(expect.arrayContaining(['acct-1']));
    expect(whereParams(sandboxWhereArg)).not.toContain(ME);
    expect(whereParams(sandboxWhereArg)).not.toContain('acct-2');
    expect(whereParams(sessionUpdateWhereArg)).not.toContain(ME);
  });

  test('a scheduled request filed by someone else (an operator acting as the customer) never deletes them', async () => {
    ownedAccountRows = [{ accountId: 'operator-1' }];
    scheduledRequests = [{ id: 'req-1', accountId: 'acct-1', userId: 'operator-1' }];

    expect(await processScheduledDeletions()).toEqual({ processed: 1, errors: [] });

    expect(whereParams(swept(accounts))).toContain('acct-1');
    expect(deletedUsers).toEqual([]);
    expect(whereParams(sessionUpdateWhereArg)).not.toContain('operator-1');
    expect(completedRequests).toEqual(['req-1']);
  });
});

test('a GoTrue confirmation racing deletion cannot restore cached liveness', async () => {
  let release: (user: { id: string; email: string }) => void = () => {};
  const pendingAnswer = new Promise<{ id: string; email: string }>((resolve) => { release = resolve; });
  let calls = 0;
  liveness.__setJwtLivenessLoaderForTests(async () => {
    calls++;
    return calls === 1 ? pendingAnswer : null;
  });
  const pending = liveness.confirmJwtLive('racing-token', Math.floor(Date.now() / 1000) + 3600);
  await deleteAccountImmediately(ME, ME);
  release({ id: ME, email: '' });
  expect(await pending).toBeNull();
  expect(liveness.jwtLivenessCacheSize()).toBe(0);
});

for (const ttl of [0, 30000]) {
  test(`every GoTrue retry validates two deletion invalidations at TTL ${ttl}`, async () => {
    config.SUPABASE_JWT_LIVENESS_TTL_MS = ttl;
    let calls = 0;
    liveness.__setJwtLivenessLoaderForTests(async () => {
      calls++;
      if (calls <= 2) {
        liveness.forgetUserJwtLiveness('user-1');
        return { id: 'user-1', email: '' };
      }
      return null;
    });
    try {
      expect(await liveness.confirmJwtLive('twice-invalidated-token', Math.floor(Date.now() / 1000) + 3600)).toBeNull();
      expect(calls).toBe(3);
      expect(liveness.jwtLivenessCacheSize()).toBe(0);
    } finally {
      config.SUPABASE_JWT_LIVENESS_TTL_MS = 30000;
      liveness.__setJwtLivenessLoaderForTests(null);
    }
  });
}

test('deletion in the loader completion microtask cannot republish cached liveness', async () => {
  const answer = Promise.resolve({ id: 'user-1', email: '' });
  let calls = 0;
  liveness.__setJwtLivenessLoaderForTests(() => {
    calls++;
    return calls === 1 ? answer : Promise.resolve(null);
  });
  const pending = liveness.confirmJwtLive('publication-gap-token', Math.floor(Date.now() / 1000) + 3600);
  await answer.then(() => liveness.forgetUserJwtLiveness('user-1'));
  await pending;
  expect(liveness.jwtLivenessCacheSize()).toBe(0);
  expect(await liveness.confirmJwtLive('publication-gap-token', Math.floor(Date.now() / 1000) + 3600)).toBeNull();
});
