import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { accountInvitations, accountMembers, accounts, accountUser, projectMembers, projects } from '@kortix/db';

const OWNER_ID = '00000000-0000-4000-a000-000000000001';
const MEMBER_ID = '00000000-0000-4000-a000-000000000002';
const OUTSIDER_ID = '00000000-0000-4000-a000-000000000003';
const INVITEE_ID = '00000000-0000-4000-a000-000000000004';
const ACCOUNT_ID = '00000000-0000-4000-a000-000000000101';
const PERSONAL_ACCOUNT_ID = '00000000-0000-4000-a000-000000000102';
const CREATED_ACCOUNT_ID = '00000000-0000-4000-a000-000000000103';
const INVITE_ID = '00000000-0000-4000-a000-000000000201';

type AccountRole = 'owner' | 'admin' | 'member';

interface AccountRow {
  accountId: string;
  name: string;
  personalAccount: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface MemberRow {
  userId: string;
  accountId: string;
  accountRole: AccountRole;
  joinedAt: Date;
}

interface InviteRow {
  inviteId: string;
  accountId: string;
  email: string;
  invitedBy: string | null;
  initialRole: AccountRole;
  acceptedAt: Date | null;
  createdAt: Date;
  expiresAt: Date;
}

const baseDate = new Date('2026-01-01T00:00:00Z');
const futureDate = new Date('2999-02-01T00:00:00Z');
const pastDate = new Date('2025-12-01T00:00:00Z');

let currentUserId: string | null;
let currentUserEmail: string;
let accountRows: AccountRow[];
let memberRows: MemberRow[];
let inviteRows: InviteRow[];
let authUsers: Array<{ id: string; email: string }>;
let sentInvites: Array<Record<string, unknown>>;
let nextAccountId: string;
let nextInviteId: string;

function resetState() {
  currentUserId = OWNER_ID;
  currentUserEmail = 'owner@example.test';
  accountRows = [{
    accountId: ACCOUNT_ID,
    name: 'Team Account',
    personalAccount: false,
    createdAt: baseDate,
    updatedAt: baseDate,
  }, {
    accountId: PERSONAL_ACCOUNT_ID,
    name: 'Owner Personal',
    personalAccount: true,
    createdAt: baseDate,
    updatedAt: baseDate,
  }];
  memberRows = [{
    userId: OWNER_ID,
    accountId: ACCOUNT_ID,
    accountRole: 'owner',
    joinedAt: baseDate,
  }, {
    userId: OWNER_ID,
    accountId: PERSONAL_ACCOUNT_ID,
    accountRole: 'owner',
    joinedAt: baseDate,
  }];
  inviteRows = [];
  authUsers = [
    { id: OWNER_ID, email: 'owner@example.test' },
    { id: MEMBER_ID, email: 'member@example.test' },
    { id: OUTSIDER_ID, email: 'outsider@example.test' },
    { id: INVITEE_ID, email: 'invitee@example.test' },
  ];
  sentInvites = [];
  nextAccountId = CREATED_ACCOUNT_ID;
  nextInviteId = INVITE_ID;
}

function collectConditionValues(condition: unknown): Record<string, unknown> {
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

function queryResult<T = any>(rows: T[]) {
  return {
    then: (resolve: (value: T[]) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
    limit: async (count: number) => rows.slice(0, count),
    groupBy: async () => rows,
  };
}

function accountById(accountId: string | undefined) {
  return accountRows.find((row) => row.accountId === accountId);
}

function membership(userId: string | undefined, accountId: string | undefined) {
  return memberRows.find((row) => row.userId === userId && row.accountId === accountId);
}

function ownerCount(accountId: string | undefined) {
  return memberRows.filter((row) => row.accountId === accountId && row.accountRole === 'owner').length;
}

function selectRows(table: unknown, fields: Record<string, unknown> | undefined, condition: unknown): any[] {
  const values = collectConditionValues(condition);
  const accountId = values.account_id as string | undefined;
  const userId = values.user_id as string | undefined;
  const inviteId = values.invite_id as string | undefined;
  const accountRole = values.account_role as AccountRole | undefined;

  if (table === accountMembers) {
    if (fields && Object.keys(fields).length === 1 && Object.keys(fields)[0] === 'n') {
      return [{ n: accountRole === 'owner' ? ownerCount(accountId) : memberRows.filter((row) => row.accountId === accountId).length }];
    }
    const rows = memberRows.filter((row) =>
      (!accountId || row.accountId === accountId) &&
      (!userId || row.userId === userId) &&
      (!accountRole || row.accountRole === accountRole)
    );
    return rows.map((row) => ({
      accountId: row.accountId,
      userId: row.userId,
      accountRole: row.accountRole,
      joinedAt: row.joinedAt,
    }));
  }

  if (table === accounts) {
    const rows = accountId ? accountRows.filter((row) => row.accountId === accountId) : accountRows;
    if (fields && Object.keys(fields).length === 1 && Object.keys(fields)[0] === 'name') {
      return rows.map((row) => ({ name: row.name }));
    }
    if (fields && Object.keys(fields).length === 1 && Object.keys(fields)[0] === 'personalAccount') {
      return rows.map((row) => ({ personalAccount: row.personalAccount }));
    }
    return rows;
  }

  if (table === accountInvitations) {
    if (inviteId) return inviteRows.filter((row) => row.inviteId === inviteId);
    return inviteRows.filter((row) =>
      (!accountId || row.accountId === accountId) &&
      row.acceptedAt === null &&
      row.expiresAt.getTime() > Date.now()
    );
  }

  if (table === accountUser) return [];
  if (table === projects) return [{ n: 0 }];
  if (table === projectMembers) return [];
  return [];
}

function joinedAccountRows(condition: unknown) {
  const values = collectConditionValues(condition);
  const userId = values.user_id as string | undefined;
  return memberRows
    .filter((member) => !userId || member.userId === userId)
    .map((member) => {
      const account = accountById(member.accountId);
      return {
        accountId: member.accountId,
        accountRole: member.accountRole,
        name: account?.name ?? 'Missing account',
        personalAccount: account?.personalAccount ?? false,
        createdAt: account?.createdAt ?? baseDate,
        updatedAt: account?.updatedAt ?? baseDate,
      };
    });
}

function upsertInvite(values: any, set?: Record<string, unknown>) {
  const existing = inviteRows.find((row) => row.accountId === values.accountId && row.email === values.email);
  if (existing) {
    existing.initialRole = (set?.initialRole ?? values.initialRole) as AccountRole;
    existing.expiresAt = (set?.expiresAt ?? values.expiresAt) as Date;
    existing.invitedBy = (set?.invitedBy ?? values.invitedBy) as string;
    existing.acceptedAt = (set?.acceptedAt ?? null) as Date | null;
    return existing;
  }
  const invite: InviteRow = {
    inviteId: nextInviteId,
    accountId: values.accountId,
    email: values.email,
    invitedBy: values.invitedBy ?? null,
    initialRole: values.initialRole ?? 'member',
    acceptedAt: values.acceptedAt ?? null,
    createdAt: baseDate,
    expiresAt: values.expiresAt,
  };
  inviteRows.push(invite);
  return invite;
}

// `authorize` / `assertAuthorized` / `listAccessibleResources` are re-exported
// from `../iam` via `./dispatcher`, so the role gate must be mocked there.
mock.module('../iam/dispatcher', () => {
  // Mirror the account-role gate against the test's mocked member rows so
  // owner/admin pass writes, plain members get reads only, non-members are denied.
  const decide = (userId: string, action: string): boolean => {
    const m = memberRows.find((r) => r.userId === userId && r.accountId === ACCOUNT_ID);
    if (!m) return false;
    if (m.accountRole === 'owner' || m.accountRole === 'admin') return true;
    return action.endsWith('.read');
  };
  return {
    authorize: async (userId: string, _a: unknown, action: string) => ({ allowed: decide(userId, action) }),
    assertAuthorized: async (userId: string, _a: unknown, action: string) => {
      if (!decide(userId, action)) throw new HTTPException(403, { message: `forbidden: ${action} (denied)` });
    },
    listAccessibleResources: async () => ({ mode: 'all', ids: [] }),
  };
});

mock.module('../middleware/auth', () => ({
  supabaseAuth: async (c: any, next: any) => {
    if (!currentUserId) return c.json({ error: 'Unauthorized' }, 401);
    c.set('userId', currentUserId);
    c.set('userEmail', currentUserEmail);
    await next();
  },
}));

mock.module('../shared/supabase', () => ({
  getSupabase: () => ({
    auth: {
      admin: {
        listUsers: async () => ({ data: { users: authUsers }, error: null }),
        getUserById: async (userId: string) => ({
          data: { user: authUsers.find((user) => user.id === userId) ?? null },
        }),
      },
    },
  }),
}));

mock.module('../accounts/email', () => ({
  buildInviteUrl: (inviteId: string) => `http://localhost:3000/invites/${inviteId}`,
  sendAccountInviteEmail: async (opts: Record<string, unknown>) => {
    sentInvites.push(opts);
    return { ok: false, skipped: true, reason: 'missing_mailtrap_token' };
  },
}));

mock.module('../shared/rate-limit', () => ({
  createInviteAcceptRateLimitMiddleware: () => async (_c: any, next: any) => next(),
}));

mock.module('../shared/db', () => ({
  db: {
    select: (fields?: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        innerJoin: (joinTable: unknown) => ({
          where: (condition: unknown) => {
            if (table === accountMembers && joinTable === accounts) {
              return joinedAccountRows(condition);
            }
            return [];
          },
        }),
        where: (condition: unknown) => queryResult(selectRows(table, fields, condition)),
        groupBy: async () => [],
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: any) => {
        if (table === accounts) {
          const row: AccountRow = {
            accountId: nextAccountId,
            name: values.name,
            personalAccount: values.personalAccount ?? false,
            createdAt: baseDate,
            updatedAt: values.updatedAt ?? baseDate,
          };
          accountRows.push(row);
          return { returning: async () => [row] };
        }

        if (table === accountMembers) {
          const existing = membership(values.userId, values.accountId);
          if (!existing) {
            memberRows.push({
              userId: values.userId,
              accountId: values.accountId,
              accountRole: values.accountRole ?? 'owner',
              joinedAt: baseDate,
            });
          }
          return { onConflictDoNothing: async () => undefined };
        }

        if (table === accountInvitations) {
          return {
            onConflictDoUpdate: ({ set }: { set?: Record<string, unknown> }) => ({
              returning: async () => [upsertInvite(values, set)],
            }),
          };
        }

        return { returning: async () => [] };
      },
    }),
    update: (table: unknown) => ({
      set: (updates: any) => ({
        where: (condition: unknown) => ({
          returning: async () => {
            const values = collectConditionValues(condition);
            if (table === accounts) {
              const row = accountById(values.account_id as string);
              if (!row) return [];
              Object.assign(row, updates);
              return [row];
            }
            if (table === accountInvitations) {
              const row = inviteRows.find((invite) =>
                invite.inviteId === values.invite_id &&
                (!values.account_id || invite.accountId === values.account_id) &&
                invite.acceptedAt === null
              );
              if (!row) return [];
              Object.assign(row, updates);
              return [row];
            }
            return [];
          },
          then: async (resolve: (value: unknown[]) => unknown) => {
            const values = collectConditionValues(condition);
            if (table === accountMembers) {
              const row = membership(values.user_id as string, values.account_id as string);
              if (row) Object.assign(row, updates);
            }
            return resolve([]);
          },
        }),
      }),
    }),
    delete: (table: unknown) => ({
      where: async (condition: unknown) => {
        const values = collectConditionValues(condition);
        if (table === accountInvitations) {
          inviteRows = inviteRows.filter((row) =>
            values.invite_id && row.inviteId !== values.invite_id
          );
        }
        if (table === accountMembers) {
          memberRows = memberRows.filter((row) =>
            row.accountId !== values.account_id || row.userId !== values.user_id
          );
        }
        return [];
      },
    }),
  },
}));

const { accountsRouter } = await import('../accounts/index');
const { accountInvitesRouter } = await import('../accounts/invites');

function createApp() {
  const app = new Hono();
  app.route('/v1/accounts', accountsRouter);
  app.route('/v1/account-invites', accountInvitesRouter);
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: true, message: err.message, status: err.status }, err.status);
    }
    return c.json({ error: true, message: (err as Error).message }, 500);
  });
  return app;
}

describe('accounts API contract', () => {
  beforeEach(() => resetState());

  test('auto-creates a personal account when the caller has no membership', async () => {
    accountRows = [];
    memberRows = [];
    nextAccountId = PERSONAL_ACCOUNT_ID;
    const res = await createApp().request('/v1/accounts');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      account_id: PERSONAL_ACCOUNT_ID,
      personal_account: true,
      account_role: 'owner',
      is_primary_owner: true,
    });
    expect(memberRows).toContainEqual(expect.objectContaining({
      userId: OWNER_ID,
      accountId: PERSONAL_ACCOUNT_ID,
      accountRole: 'owner',
    }));
  });

  test('creates, reads, and renames accounts with owner-only access', async () => {
    const app = createApp();
    const missing = await app.request('/v1/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: 'name is required' });

    const tooLong = await app.request('/v1/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'a'.repeat(256) }),
    });
    expect(tooLong.status).toBe(400);
    expect(await tooLong.json()).toEqual({ error: 'name is too long' });

    const create = await app.request('/v1/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Created Team' }),
    });
    expect(create.status).toBe(201);
    expect(await create.json()).toMatchObject({
      account_id: CREATED_ACCOUNT_ID,
      name: 'Created Team',
      personal_account: false,
      account_role: 'owner',
    });

    const detail = await app.request(`/v1/accounts/${CREATED_ACCOUNT_ID}`);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      account_id: CREATED_ACCOUNT_ID,
      name: 'Created Team',
      member_count: 1,
      role: 'owner',
    });

    const rename = await app.request(`/v1/accounts/${CREATED_ACCOUNT_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed Team' }),
    });
    expect(rename.status).toBe(200);
    expect(await rename.json()).toMatchObject({ account_id: CREATED_ACCOUNT_ID, name: 'Renamed Team' });

    memberRows.push({ userId: MEMBER_ID, accountId: CREATED_ACCOUNT_ID, accountRole: 'member', joinedAt: baseDate });
    currentUserId = MEMBER_ID;
    currentUserEmail = 'member@example.test';
    const denied = await app.request(`/v1/accounts/${CREATED_ACCOUNT_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Member Rename' }),
    });
    expect(denied.status).toBe(403);
    // IAM engine denial shape (replaced the legacy manual "Owner role required" check).
    expect(await denied.json()).toMatchObject({ error: true, status: 403 });
  });

  test('distinguishes unknown account from existing non-member account', async () => {
    const app = createApp();
    const unknown = await app.request('/v1/accounts/00000000-0000-4000-a000-000000000999');
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: 'Not found' });

    currentUserId = OUTSIDER_ID;
    currentUserEmail = 'outsider@example.test';
    const nonMember = await app.request(`/v1/accounts/${ACCOUNT_ID}`);
    expect(nonMember.status).toBe(403);
    expect(await nonMember.json()).toEqual({ error: 'Forbidden' });
  });

  test('adds existing users, creates pending invites, and manages invite lifecycle', async () => {
    const app = createApp();
    const added = await app.request(`/v1/accounts/${ACCOUNT_ID}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'member@example.test', role: 'admin' }),
    });
    expect(added.status).toBe(201);
    expect(await added.json()).toEqual({
      status: 'added',
      user_id: MEMBER_ID,
      email: 'member@example.test',
      account_role: 'admin',
    });

    const duplicate = await app.request(`/v1/accounts/${ACCOUNT_ID}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'member@example.test' }),
    });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({ error: 'Already a member' });

    authUsers = authUsers.filter((user) => user.email !== 'pending@example.test');
    const pending = await app.request(`/v1/accounts/${ACCOUNT_ID}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'pending@example.test', role: 'member' }),
    });
    expect(pending.status).toBe(201);
    expect(await pending.json()).toMatchObject({
      status: 'pending',
      invite_id: INVITE_ID,
      email: 'pending@example.test',
      account_role: 'member',
    });
    expect(sentInvites).toHaveLength(1);

    const list = await app.request(`/v1/accounts/${ACCOUNT_ID}/invites`);
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual([expect.objectContaining({ invite_id: INVITE_ID, email: 'pending@example.test' })]);

    const resend = await app.request(`/v1/accounts/${ACCOUNT_ID}/invites/${INVITE_ID}/resend`, { method: 'POST' });
    expect(resend.status).toBe(200);
    expect(await resend.json()).toMatchObject({ ok: true });
    expect(sentInvites).toHaveLength(2);

    const cancel = await app.request(`/v1/accounts/${ACCOUNT_ID}/invites/${INVITE_ID}`, { method: 'DELETE' });
    expect(cancel.status).toBe(200);
    expect(await cancel.json()).toEqual({ ok: true });
    expect(inviteRows).toHaveLength(0);
  });

  test('enforces member removal, demotion, and leave invariants', async () => {
    const app = createApp();
    const removeLastOwner = await app.request(`/v1/accounts/${ACCOUNT_ID}/members/${OWNER_ID}`, { method: 'DELETE' });
    expect(removeLastOwner.status).toBe(409);
    expect(await removeLastOwner.json()).toEqual({ error: 'Cannot remove the last owner' });

    const demoteLastOwner = await app.request(`/v1/accounts/${ACCOUNT_ID}/members/${OWNER_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'member' }),
    });
    expect(demoteLastOwner.status).toBe(409);
    expect(await demoteLastOwner.json()).toEqual({ error: 'Cannot demote the last owner' });

    memberRows.push({ userId: MEMBER_ID, accountId: ACCOUNT_ID, accountRole: 'admin', joinedAt: baseDate });
    currentUserId = MEMBER_ID;
    currentUserEmail = 'member@example.test';
    const adminRemoveOwner = await app.request(`/v1/accounts/${ACCOUNT_ID}/members/${OWNER_ID}`, { method: 'DELETE' });
    expect(adminRemoveOwner.status).toBe(403);
    expect(await adminRemoveOwner.json()).toEqual({ error: 'Admins cannot remove owners' });

    currentUserId = OWNER_ID;
    currentUserEmail = 'owner@example.test';
    const leavePersonal = await app.request(`/v1/accounts/${PERSONAL_ACCOUNT_ID}/leave`, { method: 'POST' });
    expect(leavePersonal.status).toBe(409);
    expect(await leavePersonal.json()).toEqual({ error: 'Personal accounts cannot be left' });
  });

  test('redacts invites for wrong users and enforces invite accept failure modes', async () => {
    const app = createApp();
    inviteRows.push({
      inviteId: INVITE_ID,
      accountId: ACCOUNT_ID,
      email: 'invitee@example.test',
      invitedBy: OWNER_ID,
      initialRole: 'member',
      acceptedAt: null,
      createdAt: baseDate,
      expiresAt: futureDate,
    });

    currentUserId = OUTSIDER_ID;
    currentUserEmail = 'outsider@example.test';
    const redacted = await app.request(`/v1/account-invites/${INVITE_ID}`);
    expect(redacted.status).toBe(200);
    expect(await redacted.json()).toMatchObject({
      invite_id: INVITE_ID,
      email_matches_caller: false,
      account_id: null,
      email: null,
      initial_role: null,
    });

    const wrongEmail = await app.request(`/v1/account-invites/${INVITE_ID}/accept`, { method: 'POST' });
    expect(wrongEmail.status).toBe(403);

    currentUserId = INVITEE_ID;
    currentUserEmail = 'invitee@example.test';
    const full = await app.request(`/v1/account-invites/${INVITE_ID}`);
    expect(full.status).toBe(200);
    expect(await full.json()).toMatchObject({
      invite_id: INVITE_ID,
      account_id: ACCOUNT_ID,
      email: 'invitee@example.test',
      initial_role: 'member',
      inviter_email: 'owner@example.test',
      email_matches_caller: true,
    });

    const accepted = await app.request(`/v1/account-invites/${INVITE_ID}/accept`, { method: 'POST' });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({
      account_id: ACCOUNT_ID,
      account_role: 'member',
      bootstrap_grants_applied: [],
    });
    expect(membership(INVITEE_ID, ACCOUNT_ID)?.accountRole).toBe('member');
    expect(inviteRows[0]?.acceptedAt).toBeInstanceOf(Date);

    const again = await app.request(`/v1/account-invites/${INVITE_ID}/accept`, { method: 'POST' });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({
      account_id: ACCOUNT_ID,
      account_role: 'member',
      already_accepted: true,
    });

    inviteRows[0] = {
      ...inviteRows[0]!,
      inviteId: '00000000-0000-4000-a000-000000000202',
      acceptedAt: null,
      expiresAt: pastDate,
    };
    const expired = await app.request('/v1/account-invites/00000000-0000-4000-a000-000000000202/accept', { method: 'POST' });
    expect(expired.status).toBe(410);
  });
});
