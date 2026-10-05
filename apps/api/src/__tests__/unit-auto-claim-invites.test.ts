import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { mockIamAssignments } from './helpers/iam-mocks';

// Unit-tests autoClaimPendingInvites in isolation. The whole point of the fix:
// auto-claim silently joins the account + stamps accepted_at for PLAIN account
// invites, but must leave PROJECT invites (the ones carrying bootstrap grants)
// pending so the recipient goes through the explicit accept dialog — which is
// the only path that applies the project_members grant.

const accounts = { __table: 'accounts', accountId: 'accountId' };
const accountMembers = { __table: 'accountMembers', userId: 'userId', accountId: 'accountId' };
// The IDENTITY table `account_members` became a view over. `mock.module`
// replaces `@kortix/db` WHOLESALE, so a missing name is a SyntaxError in every
// importer — it has to be declared even where this suite never reads it.
const accountMemberships = { __table: 'accountMemberships', userId: 'userId', accountId: 'accountId' };
const accountInvitations = {
  __table: 'accountInvitations',
  inviteId: 'inviteId',
  accountId: 'accountId',
  email: 'email',
  acceptedAt: 'acceptedAt',
  expiresAt: 'expiresAt',
};

type FakeInvite = {
  inviteId: string;
  accountId: string;
  email: string;
  initialRole: string;
  bootstrapGrants: unknown[] | null;
  acceptedAt: Date | null;
  expiresAt: Date;
};

const state = { pending: [] as FakeInvite[] };
const memberInserts: Array<Record<string, unknown>> = [];
const inviteUpdates: Array<Record<string, unknown>> = [];
/** The ROLE half of an auto-claim: one `assignRole` call, not a column. */
const roleGrants: Array<{ accountId: string; userId: string; roleKey?: string }> = [];

const fakeDb = {
  // autoClaim does: db.select().from(accountInvitations).where(and(...)) → rows
  select: () => ({
    from: () => ({
      where: async () => state.pending,
    }),
  }),
  // db.insert(accountMembers).values({...}).onConflictDoNothing({...})
  insert: (table: { __table: string }) => ({
    values: (data: Record<string, unknown>) => {
      memberInserts.push({ table: table.__table, ...data });
      return { onConflictDoNothing: async () => undefined };
    },
  }),
  // db.update(accountInvitations).set({ acceptedAt }).where(eq(...))
  update: (table: { __table: string }) => ({
    set: (data: Record<string, unknown>) => ({
      where: async () => {
        inviteUpdates.push({ table: table.__table, ...data });
      },
    }),
  }),
};

const actualDrizzle = await import('drizzle-orm');
mock.module('drizzle-orm', () => ({
  ...actualDrizzle,
  and: (...parts: unknown[]) => ({ op: 'and', parts }),
  eq: (column: unknown, value: unknown) => ({ op: 'eq', column, value }),
  gt: (column: unknown, value: unknown) => ({ op: 'gt', column, value }),
  isNull: (column: unknown) => ({ op: 'isNull', column }),
  sql: (...args: unknown[]) => ({ op: 'sql', args }),
  count: (column?: unknown) => ({ op: 'count', column }),
}));

// Wholesale replacement — declare every table this file's graph reaches, now
// that membership is read from `role_assignments` and written through
// `assignRole` (which also writes an audit event).
// Claiming an invite is TWO writes since the cutover: the IDENTITY row
// (`account_memberships`) and the account-scope ROLE (`assignRole`). The role
// half writes `role_assignments`, which this suite's fake db does not model, so
// it is bypassed and captured instead.
mockIamAssignments({
  onGrant: ({ accountId, principal, roleKey }) => {
    roleGrants.push({ accountId, userId: principal.id, roleKey });
  },
});

mock.module('@kortix/db', () => ({
  accounts,
  accountMembers,
  accountMemberships,
  accountInvitations,
  roleAssignments: {},
  iamRoles: {},
  iamRoleActions: {},
  auditEvents: {},
  serviceAccounts: {},
  accountTokens: {},
  accountGroups: {},
  accountGroupMembers: {},
  objectPolicies: {},
  permissions: {},
}));
mock.module('../shared/db', () => ({ db: fakeDb }));
mock.module('../shared/supabase', () => ({
  getSupabase: () => ({
    auth: { admin: { getUserById: async () => ({ data: { user: null } }) } },
  }),
}));
mock.module('../shared/resolve-account', () => ({ resolveAccountId: async () => 'acct' }));
mock.module('../openapi', () => ({ makeOpenApiApp: () => ({}) }));
// The email a claim matches comes from the email-trust rule, not the token:
// an SSO identity whose IdP did not verify the email's domain resolves to ''.
const trust = { byUser: new Map<string, string>() };
mock.module('../iam/email-trust', () => ({
  trustedEmailForUser: async (userId: string) => trust.byUser.get(userId) ?? '',
  emailTrustedSql: () => ({ op: 'sql', args: ['true'] }),
}));

const { autoClaimPendingInvites } = await import('../accounts/core/app');

function makeInvite(overrides: Partial<FakeInvite>): FakeInvite {
  return {
    inviteId: 'invite-1',
    accountId: 'acct-1',
    email: 'invitee@example.com',
    initialRole: 'member',
    bootstrapGrants: null,
    acceptedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

beforeEach(() => {
  trust.byUser = new Map([['user-1', 'invitee@example.com']]);
  state.pending = [];
  memberInserts.length = 0;
  inviteUpdates.length = 0;
  roleGrants.length = 0;
});

describe('autoClaimPendingInvites', () => {
  test('claims a plain account invite (no bootstrap grants): joins + stamps accepted_at', async () => {
    state.pending = [makeInvite({ bootstrapGrants: null })];

    // The count lets GET /v1/accounts skip its membership re-read when 0.
    expect(await autoClaimPendingInvites('user-1', 'invitee@example.com')).toBe(1);

    expect(memberInserts).toHaveLength(1);
    expect(memberInserts[0]).toMatchObject({
      table: 'accountMemberships',
      userId: 'user-1',
      accountId: 'acct-1',
    });
    expect(roleGrants).toEqual([
      { accountId: 'acct-1', userId: 'user-1', roleKey: 'member' },
    ]);
    expect(inviteUpdates).toHaveLength(1);
    expect(inviteUpdates[0]).toMatchObject({ table: 'accountInvitations' });
    expect(inviteUpdates[0].acceptedAt).toBeInstanceOf(Date);
  });

  test('does NOT claim a project invite (carries bootstrap grants): stays pending', async () => {
    state.pending = [makeInvite({ bootstrapGrants: [{ project_id: 'p1', role: 'manager' }] })];

    expect(await autoClaimPendingInvites('user-1', 'invitee@example.com')).toBe(0);

    // No membership row and no accepted_at stamp → the inviter keeps seeing
    // "pending" and the recipient still gets the accept/decline dialog.
    expect(memberInserts).toHaveLength(0);
    expect(roleGrants).toHaveLength(0);
    expect(inviteUpdates).toHaveLength(0);
  });

  test('mixed batch: claims the plain invite, leaves the project invite pending', async () => {
    state.pending = [
      makeInvite({ inviteId: 'plain', accountId: 'acct-plain', bootstrapGrants: [] }),
      makeInvite({
        inviteId: 'project',
        accountId: 'acct-project',
        bootstrapGrants: [{ project_id: 'p1', role: 'member' }],
      }),
    ];

    expect(await autoClaimPendingInvites('user-1', 'invitee@example.com')).toBe(1);

    expect(memberInserts).toHaveLength(1);
    expect(memberInserts[0]).toMatchObject({ accountId: 'acct-plain' });
    expect(roleGrants.map((g) => g.accountId)).toEqual(['acct-plain']);
    expect(inviteUpdates).toHaveLength(1);
  });

  test('no-ops on empty email without touching the db', async () => {
    state.pending = [makeInvite({})];

    expect(await autoClaimPendingInvites('user-1', '')).toBe(0);

    expect(memberInserts).toHaveLength(0);
    expect(roleGrants).toHaveLength(0);
    expect(inviteUpdates).toHaveLength(0);
  });

  test('claims nothing for an identity whose email is not trusted (unverified SSO domain)', async () => {
    state.pending = [makeInvite({ bootstrapGrants: null })];
    trust.byUser = new Map();

    // The token still names the invite's address; only a trusted email counts.
    expect(await autoClaimPendingInvites('user-1', 'invitee@example.com')).toBe(0);

    expect(memberInserts).toHaveLength(0);
    expect(roleGrants).toHaveLength(0);
    expect(inviteUpdates).toHaveLength(0);
  });

  test('matches the trusted email, not the email the caller passed', async () => {
    state.pending = [makeInvite({ email: 'invitee@example.com' })];
    trust.byUser = new Map([['user-1', 'someone-else@example.com']]);

    expect(await autoClaimPendingInvites('user-1', 'invitee@example.com')).toBe(0);
    expect(memberInserts).toHaveLength(0);
  });
});
