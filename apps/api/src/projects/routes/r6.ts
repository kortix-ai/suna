import { buildInviteUrl, isInviteEmailConfigured, sendAccountInviteEmail } from '../../accounts/email';
import { PROJECT_ACTIONS, assertAuthorized } from '../../iam';
import { auth, errors, json } from '../../openapi';
import { db } from '../../shared/db';
import { lookupUserIdByEmail } from '../../shared/users';
import { foldEffectiveProjectAccess, isAccountManager, parseProjectRole, roleAllows, type AccountRole, type ProjectRole } from '../access';
import { createRoute, z } from '@hono/zod-openapi';
import { accountGroupMembers, accountGroups, accountInvitations, accountMembers, accounts, projectGroupGrants, projectMembers, projects } from '@kortix/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { ensureOrgMembership, grantProjectRole, loadProjectForUser, lookupEmailsByUserIds, parseExpiresAtBody } from '../lib/access';
import { AccessMemberSchema, AnyObject, projectsApp } from '../lib/app';
import { getAccountMembership } from '../lib/git';
import { readBody, serializeProject } from '../lib/serializers';

projectsApp.openapi(
  createRoute({
    method: 'patch',
    path: '/{projectId}/onboarding',
    tags: ['projects'],
    summary: 'PATCH /:projectId/onboarding',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const body = await readBody(c);
  const loaded = await loadProjectForUser(c, projectId, 'write');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const completed = body.completed === true;
  const previousMetadata = (loaded.row.metadata ?? {}) as Record<string, unknown>;
  const nextMetadata: Record<string, unknown> = { ...previousMetadata };
  if (completed) {
    nextMetadata.onboarding_completed_at = new Date().toISOString();
  } else {
    delete nextMetadata.onboarding_completed_at;
  }

  const [row] = await db
    .update(projects)
    .set({ metadata: nextMetadata, updatedAt: new Date() })
    .where(eq(projects.projectId, projectId))
    .returning();

  if (!row || row.status === 'archived') return c.json({ error: 'Not found' }, 404);
  return c.json(serializeProject(row, {
    projectRole: loaded.projectRole,
    effectiveRole: loaded.effectiveRole,
  }));
},
);

// DELETE /v1/projects/:projectId

projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{projectId}',
    tags: ['projects'],
    summary: 'DELETE /:projectId',
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
  // Deletion is admin-only. Project Editor explicitly excludes
  // project.delete; loadProjectForUser('manage') would otherwise let
  // editors through via project.write.
  await assertAuthorized(loaded.userId, loaded.row.accountId, PROJECT_ACTIONS.PROJECT_DELETE, { type: 'project', id: projectId });

  const [row] = await db
    .update(projects)
    .set({ status: 'archived', updatedAt: new Date() })
    .where(eq(projects.projectId, projectId))
    .returning();

  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json({ ok: true });
},
);

// GET /v1/projects/:projectId/access
// Lists every account member and their explicit/effective project access.

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/access',
    tags: ['access'],
    summary: 'GET /:projectId/access',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
      },
    responses: {
        200: json(z.array(AccessMemberSchema), 'Access members'),
        ...errors(404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const [accountRows, grantRows, projectGroupRows] = await Promise.all([
    db
      .select({
        userId: accountMembers.userId,
        accountRole: accountMembers.accountRole,
        joinedAt: accountMembers.joinedAt,
      })
      .from(accountMembers)
      .where(eq(accountMembers.accountId, loaded.row.accountId)),
    db
      .select({
        userId: projectMembers.userId,
        projectRole: projectMembers.projectRole,
        grantedBy: projectMembers.grantedBy,
        createdAt: projectMembers.createdAt,
        updatedAt: projectMembers.updatedAt,
        expiresAt: projectMembers.expiresAt,
      })
      .from(projectMembers)
      .where(eq(projectMembers.projectId, loaded.row.projectId)),
    // V2 group grants attached to this project. Each row lifts everyone in
    // the group to at least the grant's role on this project. Per-user
    // membership lookup happens below; we fetch group → role mapping +
    // name in one shot here so we can label sources on the response.
    db
      .select({
        groupId: projectGroupGrants.groupId,
        groupName: accountGroups.name,
        role: projectGroupGrants.role,
      })
      .from(projectGroupGrants)
      .innerJoin(accountGroups, eq(accountGroups.groupId, projectGroupGrants.groupId))
      .where(eq(projectGroupGrants.projectId, loaded.row.projectId)),
  ]);

  // For every grant-bearing group, fetch its members so we can fold their
  // inherited role into each user's effective access. One round-trip
  // covering all groups at once.
  const grantGroupIds = projectGroupRows.map((g) => g.groupId);
  const groupMemberRows = grantGroupIds.length
    ? await db
        .select({
          groupId: accountGroupMembers.groupId,
          userId: accountGroupMembers.userId,
        })
        .from(accountGroupMembers)
        .where(inArray(accountGroupMembers.groupId, grantGroupIds))
    : [];

  // Index: userId → list of { group_id, group_name, role } that contribute.
  type GroupSource = { group_id: string; group_name: string; role: ProjectRole };
  const groupSourcesByUser = new Map<string, GroupSource[]>();
  const grantByGroup = new Map(
    projectGroupRows.map((g) => [g.groupId, g] as const),
  );
  for (const m of groupMemberRows) {
    const grant = grantByGroup.get(m.groupId);
    if (!grant) continue;
    const arr = groupSourcesByUser.get(m.userId) ?? [];
    arr.push({
      group_id: grant.groupId,
      group_name: grant.groupName,
      role: grant.role as ProjectRole,
    });
    groupSourcesByUser.set(m.userId, arr);
  }

  const emails = await lookupEmailsByUserIds(accountRows.map((r) => r.userId));
  const grantsByUser = new Map(grantRows.map((r) => [r.userId, r]));
  const rank: Record<AccountRole, number> = { owner: 0, admin: 1, member: 2 };

  const members = accountRows
    .map((member) => {
      const accountRole = member.accountRole as AccountRole;
      const grant = grantsByUser.get(member.userId);
      const projectRole = (grant?.projectRole as ProjectRole | undefined) ?? null;
      const groupSources = groupSourcesByUser.get(member.userId) ?? [];

      // Pure fold — see projects/access.ts for the precedence rules.
      const fold = foldEffectiveProjectAccess({
        accountRole,
        directRole: projectRole,
        groupSources,
      });

      return {
        user_id: member.userId,
        email: emails.get(member.userId) ?? null,
        account_role: accountRole,
        project_role: projectRole,
        effective_project_role: fold.effective_project_role,
        has_implicit_access: isAccountManager(accountRole),
        /** What ultimately decided the effective role. UI labels with
         *  it: "Manager (account admin)" vs "Editor (via Engineering)". */
        effective_source: fold.effective_source,
        /** Every group attachment that includes this user. Lets the UI
         *  list multi-source access ("Editor via Engineering + Viewer
         *  via Viewers") without further API calls. */
        group_sources: fold.group_sources,
        joined_at: member.joinedAt.toISOString(),
        granted_by: grant?.grantedBy ?? null,
        granted_at: grant?.createdAt?.toISOString() ?? null,
        updated_at: grant?.updatedAt?.toISOString() ?? null,
        /** Auto-revoke timestamp for the DIRECT grant. NULL = permanent.
         *  Group-derived expiries are surfaced per-source separately
         *  (not yet wired into group_sources — follow-up). */
        expires_at: grant?.expiresAt?.toISOString() ?? null,
      };
    })
    .sort((a, b) => {
      const roleDelta = rank[a.account_role] - rank[b.account_role];
      if (roleDelta !== 0) return roleDelta;
      return (a.email ?? a.user_id).localeCompare(b.email ?? b.user_id);
    });

  return c.json({
    project_id: loaded.row.projectId,
    account_id: loaded.row.accountId,
    can_manage: roleAllows(loaded.effectiveRole, 'manage'),
    viewer_user_id: loaded.userId,
    members,
  });
},
);

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
        ...errors(400, 404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const body = await readBody(c);
  const email = (typeof body.email === 'string' ? body.email : '').trim().toLowerCase();
  const role = parseProjectRole(body.role);
  if (!email) return c.json({ error: 'email is required' }, 400);
  if (!role) return c.json({ error: 'role must be one of manager|editor|viewer' }, 400);
  const expires = parseExpiresAtBody(body.expires_at);
  if (!expires.ok) return c.json({ error: expires.error }, 400);

  const targetUserId = await lookupUserIdByEmail(email);
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
        const idx = merged.findIndex((g) => g.project_id === projectId);
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

    // Fire the invite email — same transport + template as account-level
    // invites, framed around this project. Fire-and-forget: the invitation row
    // already exists and we return the invite_url regardless, so we don't block
    // the response on Mailtrap (its 10s timeout was stacking onto the request).
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
        email_skip_reason: emailConfigured ? null : 'missing_mailtrap_token',
        message: emailConfigured
          ? `No Kortix account for that email yet — an invitation email has been sent. They'll land on this project as ${role} when they sign up.`
          : `No Kortix account for that email yet — invitation created. Share the invite link with them; they'll land on this project as ${role} when they sign up.`,
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
  await assertAuthorized(loaded.userId, loaded.row.accountId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE, { type: 'project', id: projectId });

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
      const grant = (r.bootstrapGrants ?? []).find((g) => g.project_id === projectId);
      // Defensive — the WHERE already filtered for project_id, but the
      // type system doesn't know that, and a corrupt row shouldn't 500.
      if (!grant) return null;
      return {
        invite_id: r.inviteId,
        email: r.email,
        project_role: grant.role as 'manager' | 'editor' | 'viewer',
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
  await assertAuthorized(loaded.userId, loaded.row.accountId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE, { type: 'project', id: projectId });

  const [invite] = await db
    .select({
      inviteId: accountInvitations.inviteId,
      accountId: accountInvitations.accountId,
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

  const remaining = (invite.bootstrapGrants ?? []).filter(
    (g) => g.project_id !== projectId,
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
    return c.json({ ok: true, invitation_cancelled: true });
  }

  await db
    .update(accountInvitations)
    .set({ bootstrapGrants: remaining })
    .where(eq(accountInvitations.inviteId, inviteId));

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
  await assertAuthorized(loaded.userId, loaded.row.accountId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE, { type: 'project', id: projectId });

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
  const grant = (invite.bootstrapGrants ?? []).find((g) => g.project_id === projectId);
  if (!grant) {
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


projectsApp.openapi(
  createRoute({
    method: 'put',
    path: '/{projectId}/access/{userId}',
    tags: ['access'],
    summary: 'PUT /:projectId/access/:userId',
    ...auth,
      request: {
        params: z.object({ projectId: z.string(), userId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(400, 404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const targetUserId = c.req.param('userId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  // Member management is admin-only; loadProjectForUser('manage') now
  // resolves to project.write (editor-tier), so we add an explicit
  // stricter gate here.
  await assertAuthorized(loaded.userId, loaded.row.accountId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE, { type: 'project', id: projectId });

  const body = await readBody(c);
  const role = parseProjectRole(body.role);
  if (!role) return c.json({ error: 'role must be one of manager|editor|viewer' }, 400);
  const expires = parseExpiresAtBody(body.expires_at);
  if (!expires.ok) return c.json({ error: expires.error }, 400);

  const targetMembership = await getAccountMembership(targetUserId, loaded.row.accountId);
  if (!targetMembership) {
    return c.json({ error: 'User is not a member of this account' }, 404);
  }

  const targetAccountRole = targetMembership.accountRole as AccountRole;
  if (isAccountManager(targetAccountRole)) {
    await db
      .delete(projectMembers)
      .where(and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, targetUserId),
      ));

    return c.json({
      user_id: targetUserId,
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
    account_role: targetAccountRole,
    project_role: role,
    effective_project_role: role,
    has_implicit_access: false,
  });
},
);

// DELETE /v1/projects/:projectId/access/:userId

projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{projectId}/access/{userId}',
    tags: ['access'],
    summary: 'DELETE /:projectId/access/:userId',
    ...auth,
      request: {
        params: z.object({ projectId: z.string(), userId: z.string() }),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(404, 409),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const targetUserId = c.req.param('userId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertAuthorized(loaded.userId, loaded.row.accountId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE, { type: 'project', id: projectId });

  const targetMembership = await getAccountMembership(targetUserId, loaded.row.accountId);
  if (!targetMembership) {
    return c.json({ error: 'User is not a member of this account' }, 404);
  }

  const targetAccountRole = targetMembership.accountRole as AccountRole;
  if (isAccountManager(targetAccountRole)) {
    return c.json({ error: 'Owners and admins have implicit access to every project' }, 409);
  }

  await db
    .delete(projectMembers)
    .where(and(
      eq(projectMembers.projectId, projectId),
      eq(projectMembers.userId, targetUserId),
    ));

  return c.json({ ok: true });
},
);

// ─── Project group grants (IAM V2 bulk-access channel) ────────────────────
//
// A row in project_group_grants attaches an account_group to a project
// with a chosen project_role. Every member of the group inherits that
// role on that project. These routes work for both V1 and V2 accounts —
// V1 just ignores the rows because V1's engine reads from iam_policies.
