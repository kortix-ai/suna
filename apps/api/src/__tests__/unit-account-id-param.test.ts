import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { mockIamAssignments, mockIamReadModels } from './helpers/iam-mocks';
import {
  accountInvitations,
  accountMembers,
  accountMemberships,
  accounts,
  projectMembers,
  projects,
} from '@kortix/db';

// KRTX-211 (Better Stack pattern 97669531): a request that aims a non-uuid
// segment at the accounts routes (`/v1/accounts/all`, `/v1/accounts/directory`
// from a stray client; a slug or truncated id from an old cached response)
// reached the uuid-typed `accounts.account_id` / `account_members.account_id`
// casts, died as SQLSTATE 22P02 and surfaced as an opaque 500. The params now
// validate as uuids, so the OpenAPI validation answers 400 before any handler
// or DB read. The shared `?account_id=`/body resolvers are guarded separately
// (unit-resolve-account.test.ts).

const USER_ID = '00000000-0000-4000-a000-000000000001';
const ACCOUNT_ID = '00000000-0000-4000-a000-000000000101';

let dbReads: string[] = [];

function uuidError(value: string): Error {
  return Object.assign(
    new Error(`invalid input syntax for type uuid: "${value}"`),
    { code: '22P02' },
  );
}

function conditionValues(condition: unknown): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  const visit = (node: any) => {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node.queryChunks) visit(node.queryChunks);
    if (Object.prototype.hasOwnProperty.call(node, 'value') && node.encoder?.name) {
      values[node.encoder.name] = node.value;
    }
  };
  visit(condition);
  return values;
}

// Postgres rejects a non-uuid literal against a uuid column with 22P02; the
// shim mirrors that so a regression lands as the prod 500, not a quiet 404.
function rowsFor(table: unknown, condition: unknown): unknown[] {
  const accountId = conditionValues(condition).account_id as string | undefined;
  if (accountId !== undefined && !/^[0-9a-f-]{36}$/i.test(accountId)) throw uuidError(accountId);
  dbReads.push(String((table as { __table?: string }).__table ?? 'unknown'));
  if (table === accounts) {
    return accountId === ACCOUNT_ID
      ? [{ accountId: ACCOUNT_ID, name: 'Team', personalAccount: false }]
      : [];
  }
  if (table === accountMembers || table === accountMemberships) {
    return accountId === ACCOUNT_ID ? [{ accountId: ACCOUNT_ID, userId: USER_ID, accountRole: 'owner' }] : [];
  }
  return [];
}

const dbShim = {
  select: (fields?: Record<string, unknown>) => ({
    from: (table: unknown) => ({
      innerJoin: (joinTable: unknown) => ({
        where: (condition: unknown) => {
          dbReads.push(`join:${String((table as { __table?: string }).__table ?? 'unknown')}`);
          return { groupBy: async () => [], limit: async () => [] };
        },
      }),
      where: (condition: unknown) => ({
        limit: async (count: number) => rowsFor(table, condition).slice(0, count),
        orderBy: () => ({ limit: async (count: number) => rowsFor(table, condition).slice(0, count) }),
        groupBy: async () => [],
      }),
      groupBy: async () => [],
    }),
  }),
  insert: (table: unknown) => ({
    values: (data: Record<string, unknown>) => {
      dbReads.push(`insert:${String((table as { __table?: string }).__table ?? 'unknown')}`);
      return { onConflictDoNothing: async () => undefined, returning: async () => [] };
    },
  }),
  update: (table: unknown) => ({
    set: (data: Record<string, unknown>) => ({
      where: () => ({ limit: async () => [] }),
    }),
  }),
  delete: (table: unknown) => ({
    where: () => ({ limit: async () => [] }),
  }),
  execute: async () => ({ rows: [] }),
};

mock.module('../shared/db', () => ({ hasDatabase: () => true, db: dbShim }));

mock.module('../middleware/auth', () => ({
  supabaseAuth: async (c: any, next: any) => {
    c.set('userId', USER_ID);
    c.set('userEmail', 'owner@example.test');
    c.set('authType', 'supabase');
    await next();
  },
}));

// The membership read model is the funnel getMembership reaches for a valid
// uuid; counting its calls proves the malformed-id guard short-circuits
// before it.
let readModelCalls = 0;
mockIamReadModels({
  members: () => {
    readModelCalls += 1;
    return [];
  },
});
mockIamAssignments({ onGrant: () => {} });

mock.module('../iam/authorize', () => ({
  authorize: async () => ({ allowed: true, reason: 'role' }),
  assertAuthorized: async () => {},
  listAccessible: async () => ({ mode: 'all' }),
  filterAccessibleObjects: async (_a: unknown, _p: string, _t: string, ids: readonly string[]) => [...ids],
  loadObjectGrants: Object.assign(async () => new Map(), { clear: () => {} }),
  clearAuthorizeCaches: () => {},
  isImplicitManager: (key: string | null) => key === 'owner' || key === 'admin',
  // accounts/index.ts mounts accountSsoGate, which reads this; SSO is out of
  // scope here, so the gate never fires.
  ssoRequiredFor: async () => false,
  // The access-MFA gate (KRTX-1742) reads this per request; out of scope.
  mfaGateBlocks: () => false,
}));

mock.module('../iam/email-trust', () => ({
  trustedEmailForUser: async (userId: string | null | undefined) =>
    userId === USER_ID ? 'owner@example.test' : '',
  emailTrustedSql: () => sql`true`,
}));

mock.module('../shared/supabase', () => ({
  toPublicStorageUrl: (url: string) => url,
  getSupabase: () => ({
    auth: {
      admin: {
        listUsers: async () => ({ data: { users: [{ id: USER_ID, email: 'owner@example.test' }] }, error: null }),
        getUserById: async (userId: string) => ({
          data: { user: userId === USER_ID ? { id: USER_ID, email: 'owner@example.test' } : null },
        }),
      },
    },
  }),
}));

mock.module('../accounts/email', () => ({
  buildInviteUrl: (inviteId: string) => `http://localhost:3000/invites/${inviteId}`,
  sendAccountInviteEmail: async () => ({ ok: false, skipped: true, reason: 'email_not_configured' }),
}));

mock.module('../shared/rate-limit', () => ({
  createInviteAcceptRateLimitMiddleware: () => async (_c: any, next: any) => next(),
  createProjectSecretWriteRateLimitMiddleware: () => async (_c: any, next: any) => next(),
  // The Capture enrollment routes (mounted on accountsRouter) build a limiter at import.
  TokenBucketRateLimiter: class {
    check() {
      return { allowed: true };
    }
  },
}));

mock.module('../shared/resolve-account', () => ({
  resolveAccountId: async () => ACCOUNT_ID,
}));

const { accountsRouter } = await import('../accounts/index');
const { getMembership } = await import('../accounts/core/app');

function createApp() {
  const app = new Hono();
  app.route('/v1/accounts', accountsRouter);
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: true, message: err.message, status: err.status }, err.status);
    }
    // Mirror the API's global onError: an unknown error (a raw PostgresError)
    // leaves as an opaque 500 — exactly what prod answered before the fix.
    return c.json({ error: true, message: (err as Error).message }, 500);
  });
  return app;
}

beforeEach(() => {
  dbReads = [];
  readModelCalls = 0;
});

describe('accounts route uuid params (KRTX-211)', () => {
  test('a stray literal segment is answered 400 before any DB read', async () => {
    const res = await createApp().request('/v1/accounts/directory');
    expect(res.status).toBe(400);
    expect(dbReads).toEqual([]);
  });

  test('the observed `/all` segment is answered 400 too', async () => {
    const res = await createApp().request('/v1/accounts/all');
    expect(res.status).toBe(400);
    expect(dbReads).toEqual([]);
  });

  test('a valid uuid still flows through to the detail route', async () => {
    const res = await createApp().request(`/v1/accounts/${ACCOUNT_ID}`);
    // Whatever the handler's own verdict is on an absent account (404 here),
    // the point is that validation did not reject a well-formed uuid and no
    // cast error surfaced as 400/500.
    expect([400, 500]).not.toContain(res.status);
    expect(dbReads.length).toBeGreaterThan(0);
  });

  test('the `?account_id=` resolver guard answers the clean 403 (tokens route)', async () => {
    const res = await createApp().request('/v1/accounts/tokens?account_id=directory');
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('not a member of the requested account');
    expect(dbReads).toEqual([]);
  });

  test('getMembership answers "not a member" for a malformed id without a read', async () => {
    // Every account sub-route handler resolves the caller's membership by the
    // raw :accountId param first (members, invites, devices, branding). A
    // malformed segment must short-circuit in the funnel — never reach the
    // read model's uuid casts.
    expect(await getMembership(USER_ID, 'directory')).toBeNull();
    expect(readModelCalls).toBe(0);
    // A valid uuid still flows through to the read model.
    expect(await getMembership(USER_ID, ACCOUNT_ID)).toBeNull();
    expect(readModelCalls).toBe(1);
  });
});
