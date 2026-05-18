import { Context, Hono } from 'hono';
import { and, count, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { accountInvitations, accountMembers, accounts, accountSecrets, accountUser, projectMembers, projects } from '@kortix/db';
import type { AppEnv } from '../types';
import { db } from '../shared/db';
import { supabaseAuth } from '../middleware/auth';
import { getSupabase } from '../shared/supabase';
import { sendAccountInviteEmail } from './email';
import {
  encryptAccountSecret,
  isValidSecretName,
  type AccountSecretKind,
} from './secrets';

export const accountsRouter = new Hono<AppEnv>();

accountsRouter.use('/*', supabaseAuth);

type AccountRole = 'owner' | 'admin' | 'member';

async function readBody(c: Context): Promise<Record<string, unknown>> {
  try {
    return (await c.req.json()) ?? {};
  } catch {
    return {};
  }
}

function normalizeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeEmail(value: unknown): string | null {
  const raw = normalizeString(value);
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (!lower.includes('@')) return null;
  return lower;
}

function parseRole(value: unknown, allowed: AccountRole[]): AccountRole | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  return (allowed as string[]).includes(v) ? (v as AccountRole) : null;
}

async function getMembership(userId: string, accountId: string) {
  const [row] = await db
    .select({ accountRole: accountMembers.accountRole })
    .from(accountMembers)
    .where(and(eq(accountMembers.userId, userId), eq(accountMembers.accountId, accountId)))
    .limit(1);
  return row ?? null;
}

async function countOwners(accountId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(accountMembers)
    .where(and(eq(accountMembers.accountId, accountId), eq(accountMembers.accountRole, 'owner')));
  return Number(row?.n ?? 0);
}

async function lookupUserIdByEmail(email: string): Promise<string | null> {
  const supabase = getSupabase();
  let page = 1;
  const perPage = 200;
  // Cap pagination to avoid runaway loops on huge auth tables.
  while (page <= 50) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error || !data) return null;
    for (const u of data.users) {
      if (u.email && u.email.trim().toLowerCase() === email) return u.id;
    }
    if (data.users.length < perPage) return null;
    page += 1;
  }
  return null;
}

async function lookupEmailsByUserIds(userIds: string[]): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  if (userIds.length === 0) return result;
  const supabase = getSupabase();
  await Promise.all(
    userIds.map(async (uid) => {
      try {
        const { data } = await supabase.auth.admin.getUserById(uid);
        result.set(uid, data?.user?.email ?? null);
      } catch {
        result.set(uid, null);
      }
    }),
  );
  return result;
}

function serializeAccount(row: typeof accounts.$inferSelect) {
  return {
    account_id: row.accountId,
    name: row.name,
    slug: row.accountId.slice(0, 8),
    personal_account: row.personalAccount,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

// Auto-claim any pending invitations matching the caller's email. Each invite
// becomes an account_members row (skipped on duplicate) and its accepted_at is
// stamped so subsequent calls are no-ops. Errors are swallowed — auto-claim is
// best-effort and must never block account listing.
async function autoClaimPendingInvites(userId: string, email: string): Promise<void> {
  if (!email) return;
  const normalized = email.trim().toLowerCase();
  if (!normalized) return;

  try {
    const pending = await db
      .select()
      .from(accountInvitations)
      .where(
        and(
          sql`lower(${accountInvitations.email}) = ${normalized}`,
          isNull(accountInvitations.acceptedAt),
          gt(accountInvitations.expiresAt, new Date()),
        ),
      );

    for (const invite of pending) {
      try {
        await db
          .insert(accountMembers)
          .values({
            userId,
            accountId: invite.accountId,
            accountRole: invite.initialRole,
          })
          .onConflictDoNothing({
            target: [accountMembers.userId, accountMembers.accountId],
          });
        await db
          .update(accountInvitations)
          .set({ acceptedAt: new Date() })
          .where(eq(accountInvitations.inviteId, invite.inviteId));
      } catch {
        // Skip individual invite failures; keep processing the rest.
      }
    }
  } catch {
    // Table may not exist yet — fall through.
  }
}

// GET /v1/accounts — list user's accounts.
accountsRouter.get('/', async (c) => {
  const userId = c.get('userId') as string;
  const userEmail = c.get('userEmail') as string;

  await autoClaimPendingInvites(userId, userEmail);

  try {
    const memberships = await db
      .select({
        accountId: accountMembers.accountId,
        accountRole: accountMembers.accountRole,
        name: accounts.name,
        personalAccount: accounts.personalAccount,
        createdAt: accounts.createdAt,
        updatedAt: accounts.updatedAt,
      })
      .from(accountMembers)
      .innerJoin(accounts, eq(accountMembers.accountId, accounts.accountId))
      .where(eq(accountMembers.userId, userId));

    if (memberships.length > 0) {
      return c.json(
        memberships.map((m) => ({
          account_id: m.accountId,
          name: m.name || userEmail || 'User',
          slug: m.accountId.slice(0, 8),
          personal_account: m.personalAccount,
          created_at: m.createdAt?.toISOString() ?? new Date().toISOString(),
          updated_at: m.updatedAt?.toISOString() ?? new Date().toISOString(),
          account_role: m.accountRole || 'owner',
          is_primary_owner: m.accountRole === 'owner',
        })),
      );
    }
  } catch {
    // table doesn't exist yet — fall through to legacy basejump
  }

  try {
    const legacyMemberships = await db
      .select({
        accountId: accountUser.accountId,
        accountRole: accountUser.accountRole,
      })
      .from(accountUser)
      .where(eq(accountUser.userId, userId));

    if (legacyMemberships.length > 0) {
      return c.json(
        legacyMemberships.map((m) => ({
          account_id: m.accountId,
          name: userEmail || 'User',
          slug: m.accountId.slice(0, 8),
          personal_account: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          account_role: m.accountRole || 'owner',
          is_primary_owner: m.accountRole === 'owner',
        })),
      );
    }
  } catch {
    // basejump doesn't exist
  }

  try {
    const personalName = userEmail || 'Personal';
    const [created] = await db
      .insert(accounts)
      .values({ name: personalName, personalAccount: true })
      .returning();
    await db.insert(accountMembers).values({
      userId,
      accountId: created.accountId,
      accountRole: 'owner',
    });
    return c.json([
      {
        account_id: created.accountId,
        name: created.name,
        slug: created.accountId.slice(0, 8),
        personal_account: true,
        created_at: created.createdAt.toISOString(),
        updated_at: created.updatedAt.toISOString(),
        account_role: 'owner',
        is_primary_owner: true,
      },
    ]);
  } catch {
    return c.json([
      {
        account_id: userId,
        name: userEmail || 'User',
        slug: userId.slice(0, 8),
        personal_account: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        account_role: 'owner',
        is_primary_owner: true,
      },
    ]);
  }
});

// POST /v1/accounts — create a new team account.
accountsRouter.post('/', async (c) => {
  const userId = c.get('userId') as string;
  const body = await readBody(c);
  const name = normalizeString(body.name);
  if (!name) return c.json({ error: 'name is required' }, 400);
  if (name.length > 255) return c.json({ error: 'name is too long' }, 400);

  const [account] = await db
    .insert(accounts)
    .values({ name, personalAccount: false })
    .returning();

  await db.insert(accountMembers).values({
    userId,
    accountId: account.accountId,
    accountRole: 'owner',
  });

  return c.json(
    {
      account_id: account.accountId,
      name: account.name,
      slug: account.accountId.slice(0, 8),
      personal_account: account.personalAccount,
      created_at: account.createdAt.toISOString(),
      updated_at: account.updatedAt.toISOString(),
      account_role: 'owner',
      is_primary_owner: true,
    },
    201,
  );
});

// GET /v1/accounts/:accountId — details.
accountsRouter.get('/:accountId', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');

  const [row] = await db
    .select()
    .from(accounts)
    .where(eq(accounts.accountId, accountId))
    .limit(1);
  if (!row) return c.json({ error: 'Not found' }, 404);

  const membership = await getMembership(userId, accountId);
  if (!membership) return c.json({ error: 'Forbidden' }, 403);

  const [memberCountRow] = await db
    .select({ n: count() })
    .from(accountMembers)
    .where(eq(accountMembers.accountId, accountId));
  const [projectCountRow] = await db
    .select({ n: count() })
    .from(projects)
    .where(and(eq(projects.accountId, accountId), eq(projects.status, 'active')));

  return c.json({
    account_id: row.accountId,
    name: row.name,
    personal_account: row.personalAccount,
    member_count: Number(memberCountRow?.n ?? 0),
    project_count: Number(projectCountRow?.n ?? 0),
    role: membership.accountRole,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  });
});

// PATCH /v1/accounts/:accountId — owner-only rename.
accountsRouter.patch('/:accountId', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');

  const membership = await getMembership(userId, accountId);
  if (!membership) return c.json({ error: 'Forbidden' }, 403);
  if (membership.accountRole !== 'owner') return c.json({ error: 'Owner role required' }, 403);

  const body = await readBody(c);
  const name = normalizeString(body.name);
  if (!name) return c.json({ error: 'name is required' }, 400);
  if (name.length > 255) return c.json({ error: 'name is too long' }, 400);

  const [row] = await db
    .update(accounts)
    .set({ name, updatedAt: new Date() })
    .where(eq(accounts.accountId, accountId))
    .returning();
  if (!row) return c.json({ error: 'Not found' }, 404);

  return c.json(serializeAccount(row));
});

// GET /v1/accounts/:accountId/members — list members.
accountsRouter.get('/:accountId/members', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');

  const membership = await getMembership(userId, accountId);
  if (!membership) return c.json({ error: 'Forbidden' }, 403);

  const rows = await db
    .select({
      userId: accountMembers.userId,
      accountRole: accountMembers.accountRole,
      joinedAt: accountMembers.joinedAt,
    })
    .from(accountMembers)
    .where(eq(accountMembers.accountId, accountId));

  const emails = await lookupEmailsByUserIds(rows.map((r) => r.userId));
  const projectGrantRows = await db
    .select({
      userId: projectMembers.userId,
      n: count(),
    })
    .from(projectMembers)
    .where(eq(projectMembers.accountId, accountId))
    .groupBy(projectMembers.userId);
  const projectGrantCountByUser = new Map(projectGrantRows.map((r) => [r.userId, Number(r.n ?? 0)]));

  return c.json(
    rows.map((r) => ({
      user_id: r.userId,
      email: emails.get(r.userId) ?? null,
      account_role: r.accountRole,
      explicit_project_count: projectGrantCountByUser.get(r.userId) ?? 0,
      joined_at: r.joinedAt.toISOString(),
    })),
  );
});

// POST /v1/accounts/:accountId/members — invite a user by email. If the user
// exists, they're added immediately. Otherwise we create a pending invitation
// that auto-claims on first /v1/accounts call after signup.
accountsRouter.post('/:accountId/members', async (c) => {
  const userId = c.get('userId') as string;
  const callerEmail = (c.get('userEmail') as string | undefined) ?? null;
  const accountId = c.req.param('accountId');

  const membership = await getMembership(userId, accountId);
  if (!membership) return c.json({ error: 'Forbidden' }, 403);
  if (membership.accountRole !== 'owner' && membership.accountRole !== 'admin') {
    return c.json({ error: 'Owner or admin role required' }, 403);
  }

  const body = await readBody(c);
  const email = normalizeEmail(body.email);
  if (!email) return c.json({ error: 'A valid email is required' }, 400);

  const role: AccountRole = parseRole(body.role, ['admin', 'member']) ?? 'member';

  // Need account name for the invite email
  const [accountRow] = await db
    .select({ name: accounts.name })
    .from(accounts)
    .where(eq(accounts.accountId, accountId))
    .limit(1);
  if (!accountRow) return c.json({ error: 'Account not found' }, 404);

  const targetUserId = await lookupUserIdByEmail(email);

  if (targetUserId) {
    const existing = await getMembership(targetUserId, accountId);
    if (existing) {
      return c.json({ error: 'Already a member' }, 409);
    }

    await db.insert(accountMembers).values({
      userId: targetUserId,
      accountId,
      accountRole: role,
    });

    return c.json(
      {
        status: 'added',
        user_id: targetUserId,
        email,
        account_role: role,
      },
      201,
    );
  }

  // User doesn't exist — create or refresh a pending invitation.
  // Upsert on the unique (account_id, email) index; if one exists,
  // refresh expires_at + initial_role (e.g. inviter changed role).
  const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  const [invite] = await db
    .insert(accountInvitations)
    .values({
      accountId,
      email,
      invitedBy: userId,
      initialRole: role,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: [accountInvitations.accountId, accountInvitations.email],
      set: {
        initialRole: role,
        expiresAt,
        invitedBy: userId,
        // Clear any prior accepted_at so a refreshed invite is "pending" again.
        acceptedAt: null,
      },
    })
    .returning();

  void sendAccountInviteEmail({
    email,
    accountName: accountRow.name,
    inviterEmail: callerEmail,
    inviteId: invite.inviteId,
    role: invite.initialRole === 'admin' ? 'admin' : 'member',
  });

  return c.json(
    {
      status: 'pending',
      invite_id: invite.inviteId,
      email,
      account_role: invite.initialRole,
      expires_at: invite.expiresAt.toISOString(),
    },
    201,
  );
});

// GET /v1/accounts/:accountId/invites — list pending invitations.
accountsRouter.get('/:accountId/invites', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');

  const membership = await getMembership(userId, accountId);
  if (!membership) return c.json({ error: 'Forbidden' }, 403);

  const rows = await db
    .select()
    .from(accountInvitations)
    .where(
      and(
        eq(accountInvitations.accountId, accountId),
        isNull(accountInvitations.acceptedAt),
        gt(accountInvitations.expiresAt, new Date()),
      ),
    );

  return c.json(
    rows.map((r) => ({
      invite_id: r.inviteId,
      email: r.email,
      initial_role: r.initialRole,
      invited_by: r.invitedBy,
      created_at: r.createdAt.toISOString(),
      expires_at: r.expiresAt.toISOString(),
    })),
  );
});

// DELETE /v1/accounts/:accountId/invites/:inviteId — cancel a pending invite.
accountsRouter.delete('/:accountId/invites/:inviteId', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const inviteId = c.req.param('inviteId');

  const membership = await getMembership(userId, accountId);
  if (!membership) return c.json({ error: 'Forbidden' }, 403);
  if (membership.accountRole !== 'owner' && membership.accountRole !== 'admin') {
    return c.json({ error: 'Owner or admin role required' }, 403);
  }

  await db
    .delete(accountInvitations)
    .where(
      and(
        eq(accountInvitations.inviteId, inviteId),
        eq(accountInvitations.accountId, accountId),
      ),
    );

  return c.json({ ok: true });
});

// POST /v1/accounts/:accountId/invites/:inviteId/resend — re-send the invite
// email and bump expires_at to a fresh 14-day window.
accountsRouter.post('/:accountId/invites/:inviteId/resend', async (c) => {
  const userId = c.get('userId') as string;
  const callerEmail = (c.get('userEmail') as string | undefined) ?? null;
  const accountId = c.req.param('accountId');
  const inviteId = c.req.param('inviteId');

  const membership = await getMembership(userId, accountId);
  if (!membership) return c.json({ error: 'Forbidden' }, 403);
  if (membership.accountRole !== 'owner' && membership.accountRole !== 'admin') {
    return c.json({ error: 'Owner or admin role required' }, 403);
  }

  const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  const [updated] = await db
    .update(accountInvitations)
    .set({ expiresAt })
    .where(
      and(
        eq(accountInvitations.inviteId, inviteId),
        eq(accountInvitations.accountId, accountId),
        isNull(accountInvitations.acceptedAt),
      ),
    )
    .returning();

  if (!updated) return c.json({ error: 'Invite not found' }, 404);

  const [accountRow] = await db
    .select({ name: accounts.name })
    .from(accounts)
    .where(eq(accounts.accountId, accountId))
    .limit(1);

  if (accountRow) {
    void sendAccountInviteEmail({
      email: updated.email,
      accountName: accountRow.name,
      inviterEmail: callerEmail,
      inviteId: updated.inviteId,
      role: updated.initialRole === 'admin' ? 'admin' : 'member',
    });
  }

  return c.json({ ok: true, expires_at: updated.expiresAt.toISOString() });
});

// DELETE /v1/accounts/:accountId/members/:userId — remove a member.
accountsRouter.delete('/:accountId/members/:userId', async (c) => {
  const callerUserId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const targetUserId = c.req.param('userId');

  const callerMembership = await getMembership(callerUserId, accountId);
  if (!callerMembership) return c.json({ error: 'Forbidden' }, 403);
  if (callerMembership.accountRole !== 'owner' && callerMembership.accountRole !== 'admin') {
    return c.json({ error: 'Owner or admin role required' }, 403);
  }

  const targetMembership = await getMembership(targetUserId, accountId);
  if (!targetMembership) return c.json({ error: 'Member not found' }, 404);

  // Admin cannot remove an owner.
  if (callerMembership.accountRole === 'admin' && targetMembership.accountRole === 'owner') {
    return c.json({ error: 'Admins cannot remove owners' }, 403);
  }

  if (targetMembership.accountRole === 'owner') {
    const owners = await countOwners(accountId);
    if (owners <= 1) {
      return c.json({ error: 'Cannot remove the last owner' }, 409);
    }
  }

  await db
    .delete(projectMembers)
    .where(and(eq(projectMembers.accountId, accountId), eq(projectMembers.userId, targetUserId)));

  await db
    .delete(accountMembers)
    .where(and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, targetUserId)));

  return c.json({ ok: true });
});

// PATCH /v1/accounts/:accountId/members/:userId — change role.
accountsRouter.patch('/:accountId/members/:userId', async (c) => {
  const callerUserId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const targetUserId = c.req.param('userId');

  const callerMembership = await getMembership(callerUserId, accountId);
  if (!callerMembership) return c.json({ error: 'Forbidden' }, 403);
  if (callerMembership.accountRole !== 'owner') {
    return c.json({ error: 'Owner role required' }, 403);
  }

  const body = await readBody(c);
  const newRole = parseRole(body.role, ['owner', 'admin', 'member']);
  if (!newRole) return c.json({ error: 'role must be one of owner|admin|member' }, 400);

  const targetMembership = await getMembership(targetUserId, accountId);
  if (!targetMembership) return c.json({ error: 'Member not found' }, 404);

  if (targetMembership.accountRole === newRole) {
    return c.json({
      user_id: targetUserId,
      account_role: newRole,
      unchanged: true,
    });
  }

  if (targetMembership.accountRole === 'owner' && newRole !== 'owner') {
    const owners = await countOwners(accountId);
    if (owners <= 1) {
      return c.json({ error: 'Cannot demote the last owner' }, 409);
    }
  }

  await db
    .update(accountMembers)
    .set({ accountRole: newRole })
    .where(and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, targetUserId)));

  if (newRole === 'owner' || newRole === 'admin') {
    await db
      .delete(projectMembers)
      .where(and(eq(projectMembers.accountId, accountId), eq(projectMembers.userId, targetUserId)));
  }

  return c.json({
    user_id: targetUserId,
    account_role: newRole,
  });
});

// POST /v1/accounts/:accountId/leave — leave an account.
accountsRouter.post('/:accountId/leave', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');

  const membership = await getMembership(userId, accountId);
  if (!membership) return c.json({ error: 'Not a member' }, 404);

  const [account] = await db
    .select({ personalAccount: accounts.personalAccount })
    .from(accounts)
    .where(eq(accounts.accountId, accountId))
    .limit(1);
  if (!account) return c.json({ error: 'Not found' }, 404);

  if (account.personalAccount) {
    return c.json({ error: 'Personal accounts cannot be left' }, 409);
  }

  if (membership.accountRole === 'owner') {
    const owners = await countOwners(accountId);
    if (owners <= 1) {
      return c.json({ error: 'Cannot leave as the last owner — transfer ownership first' }, 409);
    }
  }

  await db
    .delete(projectMembers)
    .where(and(eq(projectMembers.accountId, accountId), eq(projectMembers.userId, userId)));

  await db
    .delete(accountMembers)
    .where(and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, userId)));

  return c.json({ ok: true });
});

function serializeAccountSecret(row: typeof accountSecrets.$inferSelect) {
  return {
    secret_id: row.secretId,
    account_id: row.accountId,
    name: row.name,
    kind: row.kind,
    provider: row.provider,
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function isAccountManager(role: 'owner' | 'admin' | 'member'): boolean {
  return role === 'owner' || role === 'admin';
}

// GET /v1/accounts/:accountId/secrets — list account secrets (names only).
accountsRouter.get('/:accountId/secrets', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');

  const membership = await getMembership(userId, accountId);
  if (!membership) return c.json({ error: 'Forbidden' }, 403);

  const rows = await db
    .select()
    .from(accountSecrets)
    .where(eq(accountSecrets.accountId, accountId))
    .orderBy(desc(accountSecrets.updatedAt));

  return c.json({ items: rows.map(serializeAccountSecret) });
});

// POST /v1/accounts/:accountId/secrets — upsert an api_key secret.
// OAuth subscription rows are written by the /v1/oauth/<provider>/callback
// route, not here, so this endpoint intentionally only accepts kind=api_key.
accountsRouter.post('/:accountId/secrets', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');

  const membership = await getMembership(userId, accountId);
  if (!membership) return c.json({ error: 'Forbidden' }, 403);
  if (!isAccountManager(membership.accountRole)) {
    return c.json({ error: 'Owner or admin role required' }, 403);
  }

  const body = await readBody(c);
  const name = normalizeString(body.name)?.toUpperCase();
  if (!name) return c.json({ error: 'name is required' }, 400);
  if (!isValidSecretName(name)) {
    return c.json({ error: 'name must be a valid env var name (A-Z, 0-9, _; max 64 chars)' }, 400);
  }
  if (name.startsWith('KORTIX_')) {
    return c.json({ error: 'KORTIX_* names are reserved for platform runtime variables' }, 400);
  }

  const value = typeof body.value === 'string' ? body.value : null;
  if (value === null) return c.json({ error: 'value is required' }, 400);

  const kind: AccountSecretKind = 'api_key';
  const now = new Date();
  const [row] = await db
    .insert(accountSecrets)
    .values({
      accountId,
      name,
      valueEnc: encryptAccountSecret(accountId, value),
      kind,
      provider: null,
      createdBy: userId,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [accountSecrets.accountId, accountSecrets.name],
      set: {
        valueEnc: encryptAccountSecret(accountId, value),
        kind,
        provider: null,
        updatedAt: now,
      },
    })
    .returning();

  return c.json(serializeAccountSecret(row), 200);
});

// DELETE /v1/accounts/:accountId/secrets/:name
accountsRouter.delete('/:accountId/secrets/:name', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const name = c.req.param('name')?.trim().toUpperCase();

  const membership = await getMembership(userId, accountId);
  if (!membership) return c.json({ error: 'Forbidden' }, 403);
  if (!isAccountManager(membership.accountRole)) {
    return c.json({ error: 'Owner or admin role required' }, 403);
  }
  if (!name || !isValidSecretName(name)) {
    return c.json({ error: 'Invalid secret name' }, 400);
  }

  await db
    .delete(accountSecrets)
    .where(and(
      eq(accountSecrets.accountId, accountId),
      eq(accountSecrets.name, name),
    ));

  return c.json({ ok: true });
});

// Avoid unused-import lint warnings if sql tagged template isn't needed elsewhere.
void sql;
