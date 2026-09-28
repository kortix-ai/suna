/** Project invites: invite by email and manage pending invites. */
import { buildInviteUrl, isInviteEmailConfigured, sendAccountInviteEmail } from '../../accounts/email';
import { PROJECT_ACTIONS } from '../../iam';
import { resolveAccountIdentityByEmail } from '../../iam/account-identity';
import { assignPendingProjectRole, revokePendingAssignments } from '../../iam/assignments';
import { normalizeProjectRole, parseAssignableProjectRole, PROJECT_ROLE_INPUT_ERROR } from '../../iam/roles';
import { auth, errors, json } from '../../openapi';
import { db } from '../../shared/db';
import { isAccountManager } from '../access';
import { createRoute, z } from '@hono/zod-openapi';
import { accountInvitations, accounts } from '@kortix/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  ensureOrgMembership,
  grantProjectRole,
  loadProjectForUser,
  lookupEmailsByUserIds,
  parseExpiresAtBody,
  assertProjectCapability,
} from '../lib/access';
import { AnyObject, projectsApp } from '../lib/app';
import { readJsonObject } from '../../shared/http-body';

// PUT /v1/projects/:projectId/access/:userId
// POST /v1/projects/:projectId/access/invite
// Invite a person to a project by email: looks up their Kortix account, ensures
// they're an org member (creating a 'member' org row if needed), then grants the
// project role. Account managers get implicit project access (no explicit grant).

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/access/invite',
    tags: ['access'],
    summary: 'POST /:projectId/access/invite',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(400, 404, 409),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  // Inviting a member grants project access — members.manage, not plain write.
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE);

  const body = await readJsonObject(c);
  const email = (typeof body.email === 'string' ? body.email : '').trim().toLowerCase();
  const role = parseAssignableProjectRole(body.role);
  if (!email) return c.json({ error: 'email is required' }, 400);
  if (!role) return c.json({ error: PROJECT_ROLE_INPUT_ERROR }, 400);
  const expires = parseExpiresAtBody(body.expires_at);
  if (!expires.ok) return c.json({ error: expires.error }, 400);

  const identity = await resolveAccountIdentityByEmail(loaded.row.accountId, email);
  if (identity.ambiguous) {
    return c.json({ error: 'Multiple account identities use this email', code: 'account_identity_ambiguous' }, 409);
  }
  const targetUserId = identity.userId;
  if (!targetUserId) {
    // No Kortix user yet. Upsert an account invitation carrying a
    // bootstrap_grant so when they accept, they're added to the org
    // AND granted the project role in one step — no separate "invite
    // to org, then invite to project" dance. The unique index on
    // (account_id, email) makes this idempotent; re-inviting the
    // same email to a second project merges the grants list.
    const bootstrap = {
      project_id: projectId,
      role,
      ...(expires.value
        ? { expires_at: expires.value.toISOString() }
        : {}),
    };
    // Wrap the find-or-create in a transaction with SELECT … FOR UPDATE
    // so two concurrent admins inviting the same email can't both see
    // the same pre-state and produce a last-write-wins merge that
    // drops one of their grants. The lock blocks the second admin's
    // SELECT until the first transaction commits; the second admin
    // then sees the first's grant and merges on top of it.
    const inviteId = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({
          inviteId: accountInvitations.inviteId,
          bootstrapGrants: accountInvitations.bootstrapGrants,
        })
        .from(accountInvitations)
        .where(
          and(
            eq(accountInvitations.accountId, loaded.row.accountId),
            sql`lower(${accountInvitations.email}) = ${email}`,
            isNull(accountInvitations.acceptedAt),
          ),
        )
        .for('update')
        .limit(1);
      if (existing) {
        // Merge bootstrap grants by project_id (later wins on role).
        const merged = [...(existing.bootstrapGrants ?? [])];
        const idx = merged.findIndex((g) => 'project_id' in g && g.project_id === projectId);
        if (idx >= 0) merged[idx] = bootstrap;
        else merged.push(bootstrap);
        await tx
          .update(accountInvitations)
          .set({ bootstrapGrants: merged })
          .where(eq(accountInvitations.inviteId, existing.inviteId));
        return existing.inviteId;
      }
      const [created] = await tx
        .insert(accountInvitations)
        .values({
          accountId: loaded.row.accountId,
          email,
          invitedBy: loaded.userId,
          initialRole: 'member',
          bootstrapGrants: [bootstrap],
        })
        .returning({ inviteId: accountInvitations.inviteId });
      return created.inviteId;
    });

    // The staged grant, as an assignment. `bootstrap_grants` stays the
    // acceptance path's own record; the `pending` assignment is what makes the
    // invite visible to every query that answers "who has access here".
    try {
      await assignPendingProjectRole(loaded.row.accountId, email, {
        projectId,
        roleKey: role,
        expiresAt: expires.value ?? null,
      });
    } catch (err) {
      console.warn('[projects/invite] staging the pending assignment failed', {
        projectId,
        err: (err as Error)?.message,
      });
    }

    // Fire the invite email — same transport + template as account-level
    // invites, framed around this project. Fire-and-forget: the invitation row
    // already exists and we return the invite_url regardless, so we don't block
    // the response on the email provider (its 10s timeout was stacking onto the request).
    // send() never throws (it returns a result object), but guard the promise
    // anyway so a transport-layer rejection can't surface as unhandled.
    const callerEmail = (c.get('userEmail') as string | undefined) ?? null;
    const [accountRow] = await db
      .select({ name: accounts.name })
      .from(accounts)
      .where(eq(accounts.accountId, loaded.row.accountId))
      .limit(1);
    const emailConfigured = isInviteEmailConfigured();
    if (emailConfigured) {
      void sendAccountInviteEmail({
        email,
        accountName: accountRow?.name ?? 'Kortix',
        inviterEmail: callerEmail,
        inviteId,
        role,
        projectName: loaded.row.name,
      }).catch((err) => {
        console.warn('[projects/invite] invite email send failed:', (err as Error).message);
      });
    }

    return c.json(
      {
        status: 'invited',
        email,
        invite_id: inviteId,
        project_role: role,
        invite_url: buildInviteUrl(inviteId),
        // Optimistic: send is queued, not awaited. When delivery isn't wired up
        // we know synchronously it'll be skipped, so report that honestly.
        email_sent: emailConfigured,
        email_skip_reason: emailConfigured ? null : 'email_not_configured',
        message: emailConfigured
          ? `No Kortix account for that email yet — an invitation email has been sent. After they sign up, Kortix shows them the invite and they join this project as ${role}.`
          : `No Kortix account for that email yet — invitation created. Share the invite link with them. After they sign up, Kortix shows them the invite and they join this project as ${role}.`,
      },
      201,
    );
  }

  const targetAccountRole = await ensureOrgMembership(loaded.row.accountId, targetUserId);
  if (isAccountManager(targetAccountRole)) {
    return c.json({
      user_id: targetUserId,
      email,
      account_role: targetAccountRole,
      project_role: null,
      effective_project_role: 'manager',
      has_implicit_access: true,
    });
  }

  await grantProjectRole({
    accountId: loaded.row.accountId,
    projectId,
    userId: targetUserId,
    role,
    grantedBy: loaded.userId,
    expiresAt: expires.value,
  });

  return c.json({
    user_id: targetUserId,
    email,
    account_role: targetAccountRole,
    project_role: role,
    effective_project_role: role,
    has_implicit_access: false,
  });
},
);

// GET /v1/projects/:projectId/access/pending-invites
// Lists pending account_invitations whose bootstrap_grants target this
// project. Surfaces the "I invited someone whose email doesn't have a
// Kortix account yet" intermediate state — without this the UI looks
// the same before and after a successful invite, leaving the inviter
// to wonder if anything happened.
//
// Restricted to project managers — viewers don't need to see who's
// queued up for membership.

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/access/pending-invites',
    tags: ['access'],
    summary: 'GET /:projectId/access/pending-invites',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE);

  // JSONB containment check (`@>`) finds invitations whose grants array
  // contains an entry with this project_id. Includes expired invites in
  // the result with a flag so the UI can show them dimmed + a "Resend"
  // affordance later if we want it (out of scope for now — just hide).
  const rows = await db
    .select({
      inviteId: accountInvitations.inviteId,
      email: accountInvitations.email,
      initialRole: accountInvitations.initialRole,
      invitedBy: accountInvitations.invitedBy,
      createdAt: accountInvitations.createdAt,
      expiresAt: accountInvitations.expiresAt,
      bootstrapGrants: accountInvitations.bootstrapGrants,
    })
    .from(accountInvitations)
    .where(
      and(
        eq(accountInvitations.accountId, loaded.row.accountId),
        isNull(accountInvitations.acceptedAt),
        sql`${accountInvitations.bootstrapGrants} @> ${JSON.stringify([{ project_id: projectId }])}::jsonb`,
      ),
    );

  // Resolve inviter emails in one shot (one auth.admin call per inviter
  // since the Supabase helper has no batch API; the set is tiny in
  // practice — usually 1 or 2 distinct admins).
  const inviterIds = Array.from(
    new Set(rows.map((r) => r.invitedBy).filter((v): v is string => !!v)),
  );
  const inviterEmails = await lookupEmailsByUserIds(inviterIds);

  const now = Date.now();
  const items = rows
    .map((r) => {
      const grant = (r.bootstrapGrants ?? []).find(
        (g) => 'project_id' in g && g.project_id === projectId,
      );
      // Defensive — the WHERE already filtered for project_id, but the
      // type system doesn't know that, and a corrupt row shouldn't 500.
      if (!grant || !('project_id' in grant)) return null;
      return {
        invite_id: r.inviteId,
        email: r.email,
        // Normalize a legacy `viewer`/`user` grant to `member` so the API never
        // emits a retired role.
        project_role: normalizeProjectRole(grant.role) ?? 'member',
        expires_at: grant.expires_at ?? null,
        invited_by_email: r.invitedBy ? (inviterEmails.get(r.invitedBy) ?? null) : null,
        created_at: r.createdAt.toISOString(),
        invite_expires_at: r.expiresAt.toISOString(),
        invite_expired: r.expiresAt.getTime() <= now,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  return c.json({ pending: items });
},
);

// DELETE /v1/projects/:projectId/access/pending-invites/:inviteId
// Removes this project's bootstrap_grant from a pending invitation. If
// that was the only grant AND the invitation is the auto-created
// "member" variety (always how project /access/invite creates them), the
// whole invitation row goes away — the user simply isn't being invited
// anywhere anymore. If the inviter had set a higher initial_role
// (admin/owner) or other project grants remain, we keep the invitation
// and just strip this project from it.

projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{projectId}/access/pending-invites/{inviteId}',
    tags: ['access'],
    summary: 'DELETE /:projectId/access/pending-invites/:inviteId',
    ...auth,
      request: {
        params: z.object({ projectId: z.string(), inviteId: z.string() }),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(404, 409),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const inviteId = c.req.param('inviteId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE);

  const [invite] = await db
    .select({
      inviteId: accountInvitations.inviteId,
      accountId: accountInvitations.accountId,
      email: accountInvitations.email,
      initialRole: accountInvitations.initialRole,
      acceptedAt: accountInvitations.acceptedAt,
      bootstrapGrants: accountInvitations.bootstrapGrants,
    })
    .from(accountInvitations)
    .where(eq(accountInvitations.inviteId, inviteId))
    .limit(1);

  if (!invite || invite.accountId !== loaded.row.accountId) {
    return c.json({ error: 'Invitation not found' }, 404);
  }
  if (invite.acceptedAt) {
    return c.json({ error: 'Invitation has already been accepted' }, 409);
  }

  const inviteEmail = invite.email;
  const remaining = (invite.bootstrapGrants ?? []).filter(
    (g) => !('project_id' in g) || g.project_id !== projectId,
  );

  // Auto-cancel the whole invitation if (a) nothing else is being
  // granted AND (b) the original invite was for a plain member (which
  // is the only role our project invite endpoint creates). Anything
  // higher-tier must have been set deliberately at the account level
  // and shouldn't be silently dropped.
  if (remaining.length === 0 && invite.initialRole === 'member') {
    await db
      .delete(accountInvitations)
      .where(eq(accountInvitations.inviteId, inviteId));
    await revokePendingAssignments(loaded.row.accountId, inviteEmail);
    return c.json({ ok: true, invitation_cancelled: true });
  }

  await db
    .update(accountInvitations)
    .set({ bootstrapGrants: remaining })
    .where(eq(accountInvitations.inviteId, inviteId));
  await revokePendingAssignments(loaded.row.accountId, inviteEmail, projectId);

  return c.json({ ok: true, invitation_cancelled: false });
},
);

// POST /v1/projects/:projectId/access/pending-invites/:inviteId/resend
// Re-sends the project invite email and refreshes the invitation's 14-day
// expiry. Mirrors the account-level resend, but re-frames the email around
// this project and reads the role from the bootstrap grant for this project.

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/access/pending-invites/{inviteId}/resend',
    tags: ['access'],
    summary: 'POST /:projectId/access/pending-invites/:inviteId/resend',
    ...auth,
      request: {
        params: z.object({ projectId: z.string(), inviteId: z.string() }),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(404, 409),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const inviteId = c.req.param('inviteId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE);

  const [invite] = await db
    .select({
      inviteId: accountInvitations.inviteId,
      accountId: accountInvitations.accountId,
      email: accountInvitations.email,
      acceptedAt: accountInvitations.acceptedAt,
      bootstrapGrants: accountInvitations.bootstrapGrants,
    })
    .from(accountInvitations)
    .where(eq(accountInvitations.inviteId, inviteId))
    .limit(1);

  if (!invite || invite.accountId !== loaded.row.accountId) {
    return c.json({ error: 'Invitation not found' }, 404);
  }
  if (invite.acceptedAt) {
    return c.json({ error: 'Invitation has already been accepted' }, 409);
  }
  const grant = (invite.bootstrapGrants ?? []).find(
    (g) => 'project_id' in g && g.project_id === projectId,
  );
  if (!grant || !('project_id' in grant)) {
    return c.json({ error: 'Invitation does not target this project' }, 404);
  }

  const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  await db
    .update(accountInvitations)
    .set({ expiresAt })
    .where(eq(accountInvitations.inviteId, inviteId));

  const callerEmail = (c.get('userEmail') as string | undefined) ?? null;
  const [accountRow] = await db
    .select({ name: accounts.name })
    .from(accounts)
    .where(eq(accounts.accountId, loaded.row.accountId))
    .limit(1);
  const delivery = await sendAccountInviteEmail({
    email: invite.email,
    accountName: accountRow?.name ?? 'Kortix',
    inviterEmail: callerEmail,
    inviteId: invite.inviteId,
    role: grant.role,
    projectName: loaded.row.name,
  });

  return c.json({
    ok: true,
    expires_at: expiresAt.toISOString(),
    invite_url: buildInviteUrl(invite.inviteId),
    email_sent: delivery.ok === true,
    email_skip_reason:
      delivery.ok === false && 'reason' in delivery ? delivery.reason : null,
  });
},
);
