// Regression test for the production incident where `GET /v1/accounts` timed out
// (frontend `ApiError: Request timed out after 30s: /accounts`).
//
// Root cause: the list handler `await`s `autoClaimPendingInvites` before listing,
// and that function claimed pending invites with serial, unbounded DB round-trips.
// A slow/contended DB (or a caller with many pending invites) made it run past the
// frontend's 30s request timeout, stalling account listing — which fires on nearly
// every authenticated page (account-switcher, user-menu, project-switcher, …).
//
// The fix bounds auto-claim with AUTO_CLAIM_TIMEOUT_MS and claims invites
// concurrently. These tests pin both behaviours.

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

const accounts = { __table: 'accounts', accountId: 'accountId' };
const accountMembers = {
  __table: 'accountMembers',
  accountId: 'accountId',
  userId: 'userId',
};
const accountInvitations = {
  __table: 'accountInvitations',
  email: 'email',
  acceptedAt: 'acceptedAt',
  expiresAt: 'expiresAt',
  inviteId: 'inviteId',
};

const state = {
  pendingInvites: [] as Array<{
    inviteId: string;
    accountId: string;
    initialRole: string;
    email: string;
  }>,
  // Per-write artificial latency, simulating a slow/contended DB.
  writeDelayMs: 0,
  // Whether the initial SELECT of pending invites should hang forever.
  selectHangs: false,
};

const insertValuesCalls: Array<Record<string, unknown>> = [];
const updateCalls: Array<unknown> = [];
// In-flight insert count — lets us assert claims run concurrently, not serially.
let inFlightInserts = 0;
let maxConcurrentInserts = 0;

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

const fakeDb = {
  select: () => ({
    from: (_table: { __table: string }) => ({
      where: async () => {
        if (state.selectHangs) {
          await sleep(60_000);
        }
        return state.pendingInvites;
      },
    }),
  }),
  insert: (_table: { __table: string }) => ({
    values: (data: Record<string, unknown>) => {
      insertValuesCalls.push(data);
      return {
        onConflictDoNothing: async () => {
          inFlightInserts += 1;
          maxConcurrentInserts = Math.max(maxConcurrentInserts, inFlightInserts);
          if (state.writeDelayMs) await sleep(state.writeDelayMs);
          inFlightInserts -= 1;
          return undefined;
        },
      };
    },
  }),
  update: (_table: { __table: string }) => ({
    set: () => ({
      where: async (clause: unknown) => {
        updateCalls.push(clause);
        if (state.writeDelayMs) await sleep(state.writeDelayMs);
        return undefined;
      },
    }),
  }),
};

mock.module('drizzle-orm', () => ({
  and: (...parts: unknown[]) => ({ op: 'and', parts }),
  eq: (column: string, value: unknown) => ({ op: 'eq', column, value }),
  gt: (column: string, value: unknown) => ({ op: 'gt', column, value }),
  isNull: (column: string) => ({ op: 'isNull', column }),
  count: () => ({ op: 'count' }),
  sql: (...args: unknown[]) => ({ op: 'sql', args }),
}));

mock.module('@kortix/db', () => ({
  accounts,
  accountMembers,
  accountInvitations,
}));

mock.module('../shared/db', () => ({ db: fakeDb }));

// app.ts also imports these (transitively) — stub so importing it stays cheap.
mock.module('../openapi', () => ({
  makeOpenApiApp: () => ({ openapi: () => undefined }),
}));
mock.module('../shared/supabase', () => ({ getSupabase: () => ({}) }));
mock.module('../shared/resolve-account', () => ({
  resolveAccountId: async () => 'acc-resolved',
}));

const { autoClaimPendingInvites, AUTO_CLAIM_TIMEOUT_MS } = await import(
  '../accounts/core/app'
);

beforeEach(() => {
  state.pendingInvites = [];
  state.writeDelayMs = 0;
  state.selectHangs = false;
  insertValuesCalls.length = 0;
  updateCalls.length = 0;
  inFlightInserts = 0;
  maxConcurrentInserts = 0;
});

afterEach(() => {
  mock.restore();
});

describe('autoClaimPendingInvites', () => {
  test('is a no-op for empty/blank email', async () => {
    await autoClaimPendingInvites('user-1', '');
    await autoClaimPendingInvites('user-1', '   ');
    expect(insertValuesCalls).toHaveLength(0);
  });

  test('claims each pending invite (membership insert + accept stamp)', async () => {
    state.pendingInvites = [
      { inviteId: 'i1', accountId: 'a1', initialRole: 'member', email: 'u@x.io' },
      { inviteId: 'i2', accountId: 'a2', initialRole: 'admin', email: 'u@x.io' },
    ];
    await autoClaimPendingInvites('user-1', 'U@X.io');
    expect(insertValuesCalls).toHaveLength(2);
    expect(insertValuesCalls[0]).toMatchObject({ userId: 'user-1', accountId: 'a1' });
    expect(updateCalls).toHaveLength(2);
  });

  test('claims invites concurrently, not serially', async () => {
    state.writeDelayMs = 40;
    state.pendingInvites = Array.from({ length: 6 }, (_, i) => ({
      inviteId: `i${i}`,
      accountId: `a${i}`,
      initialRole: 'member',
      email: 'u@x.io',
    }));
    await autoClaimPendingInvites('user-1', 'u@x.io');
    // Serial would peak at 1 in-flight; concurrent fans out across all invites.
    expect(maxConcurrentInserts).toBeGreaterThan(1);
  });

  // The core regression: a slow/hung DB must NOT make auto-claim run unbounded.
  // Before the fix this awaited forever (or for the serial sum of all writes),
  // which is what pushed GET /accounts past the frontend's 30s timeout.
  test('returns within the timeout budget even if the DB hangs', async () => {
    state.selectHangs = true; // the invite SELECT never resolves
    const start = Date.now();
    await autoClaimPendingInvites('user-1', 'u@x.io');
    const elapsed = Date.now() - start;
    // Generous upper bound: must be near the budget, nowhere near the 60s hang.
    expect(elapsed).toBeLessThan(AUTO_CLAIM_TIMEOUT_MS + 2000);
  });

  test('exposes a sane (sub-request-timeout) budget', () => {
    expect(AUTO_CLAIM_TIMEOUT_MS).toBeGreaterThan(0);
    // Must be well under the frontend's 30s request timeout.
    expect(AUTO_CLAIM_TIMEOUT_MS).toBeLessThan(30_000);
  });
});
