import { createRoute, z } from '@hono/zod-openapi';
import { and, count, eq, gt, isNull, sql } from 'drizzle-orm';
import { json, errors, auth } from '../../openapi';
import { accountGroupMembers, accountGroups, accountInvitations, accountMembers, accounts, projectMembers } from '@kortix/db';
import { db } from '../../shared/db';
import { lookupUserIdByEmail } from '../../shared/users';
import { sendAccountInviteEmail, buildInviteUrl } from '../email';
import { authorize, ACCOUNT_ACTIONS, assertAuthorized } from '../../iam';
import { onMemberAdded, onMemberRemoved } from '../../billing/services/seat-management';
import {
  accountsRouter,
  type AccountRole,
  AccountMemberSchema,
  AccountInviteSchema,
  AccountIdParam,
  OkSchema,
  readBody,
  normalizeEmail,
  parseRole,
  getMembership,
  countOwners,
  lookupEmailsByUserIds,
} from './app';

// Routes are registered via this function (called by the orchestrator in the
// original route-registration order).
export function registerMemberRoutes(): void {
// GET /v1/accounts/:accountId/members — list members.
accountsRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/members',
    tags: ['accounts'],
    summary: 'List account members',
    ...auth,
    request: { params: AccountIdParam },
    responses: {
      200: json(z.array(AccountMemberSchema), 'Account members'),
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');

  const membership = await getMembership(userId, accountId);
  if (!membership) return c.json({ error: 'Forbidden' }, 403);

  const rows = await db
    .select({
      userId: accountMembers.userId,
      accountRole: accountMembers.accountRole,
      isSuperAdmin: accountMembers.isSuperAdmin,
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

  // Group memberships for every member, in one query — so the member list can
  // show which groups each person belongs to without N round-trips. Wrapped so
  // a missing/drifted groups table degrades to "no chips" instead of 500-ing
  // the whole member list.
  const groupsByUser = new Map<string, Array<{ group_id: string; name: string }>>();
  try {
    const groupRows = await db
      .select({
        userId: accountGroupMembers.userId,
        groupId: accountGroups.groupId,
        name: accountGroups.name,
      })
      .from(accountGroupMembers)
      .innerJoin(accountGroups, eq(accountGroupMembers.groupId, accountGroups.groupId))
      .where(eq(accountGroups.accountId, accountId));
    for (const g of groupRows) {
      const list = groupsByUser.get(g.userId) ?? [];
      list.push({ group_id: g.groupId, name: g.name });
      groupsByUser.set(g.userId, list);
    }
  } catch {
    /* groups table unavailable — return members without group chips */
  }

  // Active-PAT counts per member, in one aggregate so the member list
  // can flag who's automating against the account. Best-effort —
  // failures degrade to "0".
  const patCountByUser = new Map<string, number>();
  try {
    const patRows = await db.execute<{ user_id: string; n: number }>(sql`
      SELECT user_id::text, COUNT(*)::int AS n
      FROM kortix.account_tokens
      WHERE account_id = ${accountId}::uuid AND status = 'active'
      GROUP BY user_id
    `);
    const patData = ((patRows as unknown) as { rows: typeof patRows }).rows ?? patRows;
    for (const row of patData as Array<{ user_id: string; n: number }>) {
      patCountByUser.set(row.user_id, row.n);
    }
  } catch {
    /* swallow — display "0 PATs" on failure */
  }

  // Verified-MFA flag per member from Supabase Auth. Same forgiving
  // fallback as above so the list never 500s if auth.mfa_factors is
  // unavailable in a given environment.
  const mfaByUser = new Map<string, boolean>();
  try {
    const mfaRows = await db.execute<{ user_id: string }>(sql`
      SELECT DISTINCT user_id::text
      FROM auth.mfa_factors
      WHERE status = 'verified'
        AND user_id IN (
          SELECT user_id FROM kortix.account_members WHERE account_id = ${accountId}::uuid
        )
    `);
    const mfaData = ((mfaRows as unknown) as { rows: typeof mfaRows }).rows ?? mfaRows;
    for (const row of mfaData as Array<{ user_id: string }>) {
      mfaByUser.set(row.user_id, true);
    }
  } catch {
    /* auth.mfa_factors unavailable in this env */
  }

  return c.json(
    rows
      // Hide phantom self-memberships: a row where user_id == account_id whose
      // user_id has no auth user (no email). These are minted when a Kortix
      // token — which the auth middleware maps to userId == accountId — hits
      // resolveAccountId; they're the account added as a member of itself and
      // show as a bare UUID. A personal account's owner also has
      // user_id == account_id but resolves to a real email, so it's kept. The
      // email==null guard is narrow (real members have user_id != account_id),
      // so a transient email-lookup miss never hides a real teammate.
      .filter((r) => !(r.userId === accountId && (emails.get(r.userId) ?? null) === null))
      .map((r) => ({
        user_id: r.userId,
        email: emails.get(r.userId) ?? null,
        account_role: r.accountRole,
        is_super_admin: r.isSuperAdmin,
        explicit_project_count: projectGrantCountByUser.get(r.userId) ?? 0,
        groups: groupsByUser.get(r.userId) ?? [],
        active_pat_count: patCountByUser.get(r.userId) ?? 0,
        has_verified_mfa: mfaByUser.get(r.userId) ?? false,
        joined_at: r.joinedAt.toISOString(),
      })),
  );
  },
);

// POST /v1/accounts/:accountId/members — invite a user by email. If the user
// exists, they're added immediately. Otherwise we create a pending invitation
// that auto-claims on first /v1/accounts call after signup.
accountsRouter.openapi(
  createRoute({
    method: 'post',
    path: '/{accountId}/members',
    tags: ['accounts'],
    summary: 'Invite a user by email (added immediately or pending invite)',
    ...auth,
    request: {
      params: AccountIdParam,
      body: {
        content: {
          'application/json': {
            schema: z.object({ email: z.string(), role: z.string().optional() }),
          },
        },
      },
    },
    responses: {
      201: json(
        z.record(z.string(), z.any()),
        'Member added or pending invitation created',
      ),
      ...errors(400, 401, 403, 404, 409),
    },
  }),
  async (c: any) => {
  const userId = c.get('userId') as string;
  const callerEmail = (c.get('userEmail') as string | undefined) ?? null;
  const accountId = c.req.param('accountId');

  const membership = await getMembership(userId, accountId);
  if (!membership) return c.json({ error: 'Forbidden' }, 403);
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.MEMBER_INVITE);

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

    // Billing v2 — mint YOLO + push +1 seat to Stripe (no-op for legacy).
    void onMemberAdded(accountId, targetUserId).catch(() => {});

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

  const delivery = await sendAccountInviteEmail({
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
      invite_url: buildInviteUrl(invite.inviteId),
      // false = email skipped or failed; UI surfaces the link so admin can share manually.
      email_sent: delivery.ok === true,
      email_skip_reason:
        delivery.ok === false && 'reason' in delivery ? delivery.reason : null,
    },
    201,
  );
  },
);

// GET /v1/accounts/:accountId/invites — list pending invitations.
accountsRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/invites',
    tags: ['accounts'],
    summary: 'List pending invitations',
    ...auth,
    request: { params: AccountIdParam },
    responses: {
      200: json(z.array(AccountInviteSchema), 'Pending invitations'),
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
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
      invite_url: buildInviteUrl(r.inviteId),
    })),
  );
  },
);

// DELETE /v1/accounts/:accountId/invites/:inviteId — cancel a pending invite.
accountsRouter.openapi(
  createRoute({
    method: 'delete',
    path: '/{accountId}/invites/{inviteId}',
    tags: ['accounts'],
    summary: 'Cancel a pending invite',
    ...auth,
    request: { params: z.object({ accountId: z.string(), inviteId: z.string() }) },
    responses: {
      200: json(OkSchema, 'Cancellation result'),
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const inviteId = c.req.param('inviteId');

  const membership = await getMembership(userId, accountId);
  if (!membership) return c.json({ error: 'Forbidden' }, 403);
  // Cancelling a pending invite is part of invite admin — same capability.
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.MEMBER_INVITE);

  await db
    .delete(accountInvitations)
    .where(
      and(
        eq(accountInvitations.inviteId, inviteId),
        eq(accountInvitations.accountId, accountId),
      ),
    );

  return c.json({ ok: true });
  },
);

// POST /v1/accounts/:accountId/invites/:inviteId/resend — re-send the invite
// email and bump expires_at to a fresh 14-day window.
accountsRouter.openapi(
  createRoute({
    method: 'post',
    path: '/{accountId}/invites/{inviteId}/resend',
    tags: ['accounts'],
    summary: 'Resend an invite email and refresh its expiry',
    ...auth,
    request: { params: z.object({ accountId: z.string(), inviteId: z.string() }) },
    responses: {
      200: json(
        z.object({
          ok: z.boolean(),
          expires_at: z.string(),
          invite_url: z.string(),
          email_sent: z.boolean(),
          email_skip_reason: z.string().nullable(),
        }),
        'Resend result',
      ),
      ...errors(401, 403, 404),
    },
  }),
  async (c: any) => {
  const userId = c.get('userId') as string;
  const callerEmail = (c.get('userEmail') as string | undefined) ?? null;
  const accountId = c.req.param('accountId');
  const inviteId = c.req.param('inviteId');

  const membership = await getMembership(userId, accountId);
  if (!membership) return c.json({ error: 'Forbidden' }, 403);
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.MEMBER_INVITE);

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

  let delivery: Awaited<ReturnType<typeof sendAccountInviteEmail>> | null = null;
  if (accountRow) {
    delivery = await sendAccountInviteEmail({
      email: updated.email,
      accountName: accountRow.name,
      inviterEmail: callerEmail,
      inviteId: updated.inviteId,
      role: updated.initialRole === 'admin' ? 'admin' : 'member',
    });
  }

  return c.json({
    ok: true,
    expires_at: updated.expiresAt.toISOString(),
    invite_url: buildInviteUrl(updated.inviteId),
    email_sent: delivery?.ok === true,
    email_skip_reason:
      delivery && delivery.ok === false && 'reason' in delivery ? delivery.reason : null,
  });
  },
);

// DELETE /v1/accounts/:accountId/members/:userId — remove a member.
accountsRouter.openapi(
  createRoute({
    method: 'delete',
    path: '/{accountId}/members/{userId}',
    tags: ['accounts'],
    summary: 'Remove a member',
    ...auth,
    request: { params: z.object({ accountId: z.string(), userId: z.string() }) },
    responses: {
      200: json(OkSchema, 'Removal result'),
      ...errors(401, 403, 404, 409),
    },
  }),
  async (c: any) => {
  const callerUserId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const targetUserId = c.req.param('userId');

  const callerMembership = await getMembership(callerUserId, accountId);
  if (!callerMembership) return c.json({ error: 'Forbidden' }, 403);
  await assertAuthorized(callerUserId, accountId, ACCOUNT_ACTIONS.MEMBER_REMOVE);

  const targetMembership = await getMembership(targetUserId, accountId);
  if (!targetMembership) return c.json({ error: 'Member not found' }, 404);

  // Admin cannot remove an owner — invariant preserved on top of IAM.
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

  // Billing v2 — revoke per-member YOLO + push -1 seat to Stripe.
  void onMemberRemoved(accountId, targetUserId).catch(() => {});

  return c.json({ ok: true });
  },
);

// PATCH /v1/accounts/:accountId/members/:userId — change role.
accountsRouter.openapi(
  createRoute({
    method: 'patch',
    path: '/{accountId}/members/{userId}',
    tags: ['accounts'],
    summary: "Change a member's role",
    ...auth,
    request: {
      params: z.object({ accountId: z.string(), userId: z.string() }),
      body: { content: { 'application/json': { schema: z.object({ role: z.string() }) } } },
    },
    responses: {
      200: json(
        z.object({
          user_id: z.string(),
          account_role: z.string(),
          unchanged: z.boolean().optional(),
        }),
        'The updated member role',
      ),
      ...errors(400, 401, 403, 404, 409),
    },
  }),
  async (c: any) => {
  const callerUserId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const targetUserId = c.req.param('userId');

  const callerMembership = await getMembership(callerUserId, accountId);
  if (!callerMembership) return c.json({ error: 'Forbidden' }, 403);
  await assertAuthorized(callerUserId, accountId, ACCOUNT_ACTIONS.MEMBER_UPDATE);

  const body = await readBody(c);
  const newRole = parseRole(body.role, ['owner', 'admin', 'member']);
  if (!newRole) return c.json({ error: 'role must be one of owner|admin|member' }, 400);

  const targetMembership = await getMembership(targetUserId, accountId);
  if (!targetMembership) return c.json({ error: 'Member not found' }, 404);

  // Only an owner may assign or change the owner role.
  if ((newRole === 'owner' || targetMembership.accountRole === 'owner') &&
      !(await authorize(callerUserId, accountId, ACCOUNT_ACTIONS.MEMBER_SUPER_ADMIN_GRANT)).allowed) {
    return c.json({ error: 'Only an owner can assign or change the owner role' }, 403);
  }

  if (targetMembership.accountRole === newRole) {
    return c.json({
      user_id: targetUserId,
      account_role: newRole,
      unchanged: true,
    });
  }

  // Preserved invariant: only an owner can grant the owner role. Otherwise
  // an admin with member.update could escalate any teammate to owner and
  // bypass every other restriction.
  if (newRole === 'owner' && callerMembership.accountRole !== 'owner') {
    return c.json({ error: 'Only owners can grant the owner role' }, 403);
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
    // Owners/admins get implicit Manager on every project; their direct
    // project_members rows would shadow nothing useful, so clean them up.
    await db
      .delete(projectMembers)
      .where(and(eq(projectMembers.accountId, accountId), eq(projectMembers.userId, targetUserId)));
  }

  return c.json({
    user_id: targetUserId,
    account_role: newRole,
  });
  },
);

// POST /v1/accounts/:accountId/leave — leave an account.
accountsRouter.openapi(
  createRoute({
    method: 'post',
    path: '/{accountId}/leave',
    tags: ['accounts'],
    summary: 'Leave an account',
    ...auth,
    request: { params: AccountIdParam },
    responses: {
      200: json(OkSchema, 'Leave result'),
      ...errors(401, 404, 409),
    },
  }),
  async (c: any) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');

  const membership = await getMembership(userId, accountId);
  if (!membership) return c.json({ error: 'Not a member' }, 404);

  // No personal/team distinction — any account can be left, EXCEPT the
  // last owner (that would orphan the account). That single rule prevents
  // the only real footgun the old "personal accounts can't be left" guard did.
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

  // Billing v2 — revoke YOLO + push -1 seat to Stripe on self-leave.
  void onMemberRemoved(accountId, userId).catch(() => {});

  return c.json({ ok: true });
  },
);
}
