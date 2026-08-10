import { buildInviteUrl, isInviteEmailConfigured, sendAccountInviteEmail } from '../../accounts/email';
import { WORKSPACE_ACTIONS, authorize } from '../../iam';
import { assertAgentScope } from '../../iam/agent-scope';
import { invalidateIamCacheForUser } from '../../iam/cache-invalidation';
import { deriveRequestContext } from '../../iam/cache';
import { normalizeWorkspaceRole } from '../../iam/role-perms';
import { auth, errors, json } from '../../openapi';
import { db } from '../../shared/db';
import { lookupUserIdByEmail } from '../../shared/users';
import { foldEffectiveWorkspaceAccess, isAccountManager, roleAllows, type AccountRole, type WorkspaceRole } from '../access';
import { createRoute, z } from '@hono/zod-openapi';
import { accountGroupMembers, accountGroups, accountInvitations, accountMembers, accounts, projectAccessRequests, projectGroupGrants, projectMembers, projects } from '@kortix/db';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { ensureOrgMembership, grantWorkspaceRole, loadWorkspaceForUser, lookupEmailsByUserIds, resolveUserIdentities, parseExpiresAtBody, assertWorkspaceCapability } from '../lib/access';
import { notifyWorkspaceAccessRequestManagers } from '../lib/access-requests';
import {
  AccessMemberSchema,
  AnyObject,
  SandboxProviderPatchResultSchema,
  SandboxProviderTransitionStateSchema,
  workspaceRoutesApp,
} from '../lib/app';
import { getAccountMembership } from '../lib/git';
import { readBody, serializeWorkspace } from '../lib/serializers';
import { metadataClearSubtreeKey, metadataMerge, metadataMergeSubtree } from '../lib/metadata-merge';
import { isFeatureFlagKey } from '../../feature-flags/registry';
import { runFeatureFlagToggleEffects } from '../../feature-flags/toggle-effects';
import { deleteManagedWorkspaceRepo } from '../lib/workspace-deletion';
import {
  requestProviderTransition,
  readPublicWorkspaceTransitionState,
  ProviderTransitionError,
} from '../provider-transition/provider-transition-service';

function serializeWorkspaceAccessRequest(row: typeof projectAccessRequests.$inferSelect) {
  return {
    request_id: row.requestId,
    account_id: row.accountId,
    workspace_id: row.workspaceId,
    requester_user_id: row.requesterUserId,
    requester_email: row.requesterEmail,
    message: row.message ?? null,
    status: row.status,
    reviewed_by: row.reviewedBy ?? null,
    reviewed_at: row.reviewedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

const ONBOARDING_USE_CASES = new Set([
  'sales',
  'support',
  'marketing',
  'engineering',
  'finance_ops',
  'hr_recruiting',
  'other',
]);
const ONBOARDING_COMPANY_SIZES = new Set(['1-10', '11-50', '51-200', '201-1000', '1000+']);

/**
 * Allowlist the guided-onboarding profile. Returns `null` when there is nothing
 * to write, so the caller can skip the UPDATE entirely rather than issue a
 * no-op that still bumps `updated_at`.
 *
 * Unknown keys and out-of-range values are DROPPED, not rejected. This is
 * best-effort survey capture fired as the user answers each question — a client
 * that sends a field we retired must not break somebody's onboarding.
 */
function pickOnboardingProfile(input: unknown): Record<string, string> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  const out: Record<string, string> = {};

  if (typeof raw.use_case === 'string' && ONBOARDING_USE_CASES.has(raw.use_case)) {
    out.use_case = raw.use_case;
  }
  if (typeof raw.company_size === 'string' && ONBOARDING_COMPANY_SIZES.has(raw.company_size)) {
    out.company_size = raw.company_size;
  }
  if (typeof raw.company_domain === 'string') {
    // 253 is the maximum length of a DNS name.
    const domain = raw.company_domain.trim().toLowerCase().slice(0, 253);
    if (domain) out.company_domain = domain;
  }

  return Object.keys(out).length > 0 ? out : null;
}

workspaceRoutesApp.openapi(
  createRoute({
    method: 'patch',
    path: '/{workspaceId}/onboarding',
    tags: ['workspaces'],
    summary: 'PATCH /:workspaceId/onboarding',
    ...auth,
      request: {
        params: z.object({ workspaceId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(404),
    },
  }),
  async (c: any) => {
  const workspaceId = c.req.param('workspaceId');
  const body = await readBody(c);
  const loaded = await loadWorkspaceForUser(c, workspaceId, 'write');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  // Two independent writes share this route. `completed` is a TOP-LEVEL
  // lifecycle flag; `profile` is a NESTED object written answer-by-answer as
  // the user moves through the onboarding wizard. A request carries one or the
  // other, never both.
  const profile = pickOnboardingProfile(body.profile);

  let metadataExpr;
  if (profile) {
    // Nested → metadataMergeSubtree, which re-reads `metadata->'onboarding'`
    // inside the statement. A top-level `||` of the whole sub-object would let
    // two concurrent writers into DIFFERENT sub-keys lose each other's update
    // one level down.
    metadataExpr = metadataMergeSubtree('onboarding', profile);
  } else if ('completed' in body) {
    // FIX-J: SQL-side atomic merge of ONLY `onboarding_completed_at` (set /
    // delete) so this write can't revert a routing pin written concurrently.
    metadataExpr =
      body.completed === true
        ? metadataMerge({ onboarding_completed_at: new Date().toISOString() })
        : metadataMerge({}, ['onboarding_completed_at']);
  } else {
    // Nothing survived the allowlist and no completion flag was sent. Return
    // the workspace unchanged rather than issue a no-op UPDATE that would still
    // bump `updated_at` and reorder project lists for no reason.
    return c.json(
      serializeWorkspace(loaded.row, {
        workspaceRole: loaded.workspaceRole,
        effectiveRole: loaded.effectiveRole,
      }),
    );
  }

  const [row] = await db
    .update(projects)
    .set({ metadata: metadataExpr, updatedAt: new Date() })
    .where(eq(projects.workspaceId, workspaceId))
    .returning();

  if (!row || row.status === 'archived') return c.json({ error: 'Not found' }, 404);
  return c.json(serializeWorkspace(row, {
    workspaceRole: loaded.workspaceRole,
    effectiveRole: loaded.effectiveRole,
  }));
},
);

// DELETE /v1/workspaces/:workspaceId

workspaceRoutesApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{workspaceId}',
    tags: ['workspaces'],
    summary: 'DELETE /:workspaceId',
    ...auth,
      request: {
        params: z.object({ workspaceId: z.string() }),
        query: z.object({ purge: z.enum(['true', 'false']).optional() }),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(404, 502),
    },
  }),
  async (c: any) => {
  const workspaceId = c.req.param('workspaceId');
  const loaded = await loadWorkspaceForUser(c, workspaceId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  // Deletion is admin-only. Workspace Editor explicitly excludes
  // project.delete; loadWorkspaceForUser('manage') would otherwise let
  // editors through via project.write.
  await assertWorkspaceCapability(c, loaded.userId, loaded.row.accountId, workspaceId, WORKSPACE_ACTIONS.WORKSPACE_DELETE);

  // Archiving is recoverable by default. Only an explicit purge permanently
  // deletes a Kortix-managed upstream; user-connected/BYO repositories are
  // always left untouched. Delete before hiding the workspace so provider
  // failures remain visible and retryable.
  const purge = c.req.query('purge') === 'true';
  let repoDeleted = false;
  if (purge) {
    try {
      repoDeleted = await deleteManagedWorkspaceRepo(loaded.row);
    } catch (error) {
      console.error(`[workspaces] failed to delete managed repo for ${workspaceId}:`, error);
      return c.json({ error: 'Failed to delete managed workspace repository' }, 502);
    }
  }

  const [row] = await db
    .update(projects)
    .set({ status: 'archived', updatedAt: new Date() })
    .where(eq(projects.workspaceId, workspaceId))
    .returning();

  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json({ ok: true, archived: true, repo_deleted: repoDeleted });
},
);

// GET /v1/workspaces/:workspaceId/access
// Lists every account member and their explicit/effective project access.

workspaceRoutesApp.openapi(
  createRoute({
    method: 'get',
    path: '/{workspaceId}/access',
    tags: ['access'],
    summary: 'GET /:workspaceId/access',
    ...auth,
      request: {
        params: z.object({ workspaceId: z.string() }),
      },
    responses: {
        200: json(z.array(AccessMemberSchema), 'Access members'),
        ...errors(404),
    },
  }),
  async (c: any) => {
  const workspaceId = c.req.param('workspaceId');
  const loaded = await loadWorkspaceForUser(c, workspaceId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertWorkspaceCapability(c, loaded.userId, loaded.row.accountId, workspaceId, WORKSPACE_ACTIONS.WORKSPACE_MEMBERS_READ);

  const [accountRows, grantRows, workspaceGroupRows] = await Promise.all([
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
        workspaceRole: projectMembers.projectRole,
        grantedBy: projectMembers.grantedBy,
        createdAt: projectMembers.createdAt,
        updatedAt: projectMembers.updatedAt,
        expiresAt: projectMembers.expiresAt,
      })
      .from(projectMembers)
      .where(eq(projectMembers.workspaceId, loaded.row.workspaceId)),
    // V2 group grants attached to this workspace. Each row lifts everyone in
    // the group to at least the grant's role on this workspace. Per-user
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
      .where(eq(projectGroupGrants.workspaceId, loaded.row.workspaceId)),
  ]);

  // For every grant-bearing group, fetch its members so we can fold their
  // inherited role into each user's effective access. One round-trip
  // covering all groups at once.
  const grantGroupIds = workspaceGroupRows.map((g) => g.groupId);
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
  type GroupSource = { group_id: string; group_name: string; role: WorkspaceRole };
  const groupSourcesByUser = new Map<string, GroupSource[]>();
  const grantByGroup = new Map(
    workspaceGroupRows.map((g) => [g.groupId, g] as const),
  );
  for (const m of groupMemberRows) {
    const grant = grantByGroup.get(m.groupId);
    if (!grant) continue;
    const arr = groupSourcesByUser.get(m.userId) ?? [];
    arr.push({
      group_id: grant.groupId,
      group_name: grant.groupName,
      role: grant.role as WorkspaceRole,
    });
    groupSourcesByUser.set(m.userId, arr);
  }

  const identities = await resolveUserIdentities(accountRows.map((r) => r.userId));
  // Drop shadow members: an account_members row pointing at a user_id that is
  // not a real auth user (e.g. a self-referential row where user_id == the
  // account_id). These have no resolvable email and otherwise render as a bare
  // UUID in the access list.
  const realAccountRows = accountRows.filter((r) => identities.get(r.userId)?.exists !== false);
  const grantsByUser = new Map(grantRows.map((r) => [r.userId, r]));
  const rank: Record<AccountRole, number> = { owner: 0, admin: 1, member: 2 };

  const members = realAccountRows
    .map((member) => {
      const accountRole = member.accountRole as AccountRole;
      const grant = grantsByUser.get(member.userId);
      const workspaceRole = (grant?.workspaceRole as WorkspaceRole | undefined) ?? null;
      const groupSources = groupSourcesByUser.get(member.userId) ?? [];

      // Pure fold — see projects/access.ts for the precedence rules.
      const fold = foldEffectiveWorkspaceAccess({
        accountRole,
        directRole: workspaceRole,
        groupSources,
      });

      return {
        user_id: member.userId,
        email: identities.get(member.userId)?.email ?? null,
        account_role: accountRole,
        workspace_role: workspaceRole,
        effective_workspace_role: fold.effective_workspace_role,
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
    workspace_id: loaded.row.workspaceId,
    account_id: loaded.row.accountId,
    can_manage: roleAllows(loaded.effectiveRole, 'manage'),
    viewer_user_id: loaded.userId,
    members,
  });
},
);

// POST /v1/workspaces/:workspaceId/access-requests
// Lets a signed-in user with a project link ask the workspace's managers for
// access without mounting the normal project shell (which would otherwise fan
// out into many 403s). Mirrors the Figma-style "Request access" affordance.

workspaceRoutesApp.openapi(
  createRoute({
    method: 'post',
    path: '/{workspaceId}/access-requests',
    tags: ['access'],
    summary: 'POST /:workspaceId/access-requests',
    ...auth,
      request: {
        params: z.object({ workspaceId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        200: json(z.any(), 'Existing access request or access state'),
        201: json(z.any(), 'Access request created'),
        ...errors(404),
    },
  }),
  async (c: any) => {
  const workspaceId = c.req.param('workspaceId');
  const userId = c.get('userId') as string;
  const requesterEmail = ((c.get('userEmail') as string | undefined) ?? '').trim().toLowerCase();
  const body = await readBody(c);
  const messageRaw = typeof body.message === 'string' ? body.message.trim() : '';
  const message = messageRaw ? messageRaw.slice(0, 2000) : null;

  const [workspace] = await db
    .select({
      accountId: projects.accountId,
      workspaceId: projects.workspaceId,
      status: projects.status,
    })
    .from(projects)
    .where(eq(projects.workspaceId, workspaceId))
    .limit(1);
  if (!workspace || workspace.status === 'archived') return c.json({ error: 'Not found' }, 404);

  const membership = await getAccountMembership(userId, workspace.accountId);
  if (membership) {
    const actingTokenId =
      ((c as unknown as { get(k: string): unknown }).get('iamTokenId') as
        | string
        | undefined) ?? undefined;
    const verdict = await authorize(
      userId,
      workspace.accountId,
      WORKSPACE_ACTIONS.WORKSPACE_READ,
      { type: 'project', id: workspaceId },
      actingTokenId,
      deriveRequestContext(c),
    );
    if (verdict.allowed) {
      return c.json({ status: 'already_has_access', workspace_id: workspaceId });
    }
  }

  const [existing] = await db
    .select()
    .from(projectAccessRequests)
    .where(and(
      eq(projectAccessRequests.workspaceId, workspaceId),
      eq(projectAccessRequests.requesterUserId, userId),
      eq(projectAccessRequests.status, 'pending'),
    ))
    .limit(1);

  if (existing) {
    return c.json({ status: 'pending', request: serializeWorkspaceAccessRequest(existing) });
  }

  const [created] = await db
    .insert(projectAccessRequests)
    .values({
      accountId: workspace.accountId,
      workspaceId,
      requesterUserId: userId,
      requesterEmail: requesterEmail || userId,
      message,
    })
    .returning();

  await notifyWorkspaceAccessRequestManagers({
    accountId: workspace.accountId,
    workspaceId,
    requesterUserId: userId,
    requesterEmail: created.requesterEmail,
    message,
  });

  return c.json({ status: 'created', request: serializeWorkspaceAccessRequest(created) }, 201);
},
);

// GET /v1/workspaces/:workspaceId/access-requests
// Managers review pending "request access" asks from the Members screen.

workspaceRoutesApp.openapi(
  createRoute({
    method: 'get',
    path: '/{workspaceId}/access-requests',
    tags: ['access'],
    summary: 'GET /:workspaceId/access-requests',
    ...auth,
      request: {
        params: z.object({ workspaceId: z.string() }),
      },
    responses: {
        200: json(z.any(), 'Pending access requests'),
        ...errors(404),
    },
  }),
  async (c: any) => {
  const workspaceId = c.req.param('workspaceId');
  // Floor is 'read' (project membership); the real gate is the members.manage
  // leaf below, so a custom role granting ONLY members.manage (no project.write)
  // works, and — matching the sibling approve/reject routes — a plain editor
  // (project.write but not members.manage) can't list pending access requests.
  const loaded = await loadWorkspaceForUser(c, workspaceId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertWorkspaceCapability(c, loaded.userId, loaded.row.accountId, workspaceId, WORKSPACE_ACTIONS.WORKSPACE_MEMBERS_MANAGE);

  const rows = await db
    .select()
    .from(projectAccessRequests)
    .where(and(
      eq(projectAccessRequests.workspaceId, workspaceId),
      eq(projectAccessRequests.status, 'pending'),
    ))
    .orderBy(desc(projectAccessRequests.createdAt));

  return c.json({ requests: rows.map(serializeWorkspaceAccessRequest) });
},
);

// POST /v1/workspaces/:workspaceId/access-requests/:requestId/approve

workspaceRoutesApp.openapi(
  createRoute({
    method: 'post',
    path: '/{workspaceId}/access-requests/{requestId}/approve',
    tags: ['access'],
    summary: 'POST /:workspaceId/access-requests/:requestId/approve',
    ...auth,
      request: {
        params: z.object({ workspaceId: z.string(), requestId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
      200: json(z.any(), 'Access request approved'),
        ...errors(400, 404, 409),
    },
  }),
  async (c: any) => {
  const workspaceId = c.req.param('workspaceId');
  const requestId = c.req.param('requestId');
  const loaded = await loadWorkspaceForUser(c, workspaceId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  // Approving an access request grants a project role to the requester —
  // membership management, NOT plain write. loadWorkspaceForUser('manage') only
  // maps to project.write (editor), so without this an editor could approve
  // requests and even hand out the 'manager' role. Gate on members.manage.
  await assertWorkspaceCapability(c, loaded.userId, loaded.row.accountId, workspaceId, WORKSPACE_ACTIONS.WORKSPACE_MEMBERS_MANAGE);

  const body = await readBody(c);
  const role = body.role === undefined ? 'member' : normalizeWorkspaceRole(body.role);
  if (!role) return c.json({ error: 'role must be one of manager|editor|member' }, 400);

  const [request] = await db
    .select()
    .from(projectAccessRequests)
    .where(and(
      eq(projectAccessRequests.requestId, requestId),
      eq(projectAccessRequests.workspaceId, workspaceId),
    ))
    .limit(1);
  if (!request) return c.json({ error: 'Not found' }, 404);
  if (request.status !== 'pending') {
    return c.json({ error: 'Access request has already been reviewed' }, 409);
  }

  const targetAccountRole = await ensureOrgMembership(
    loaded.row.accountId,
    request.requesterUserId,
  );

  if (!isAccountManager(targetAccountRole)) {
    await grantWorkspaceRole({
      accountId: loaded.row.accountId,
      workspaceId,
      userId: request.requesterUserId,
      role,
      grantedBy: loaded.userId,
    });
  }

  const [updated] = await db
    .update(projectAccessRequests)
    .set({
      status: 'approved',
      reviewedBy: loaded.userId,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(projectAccessRequests.requestId, requestId))
    .returning();

  return c.json({
    request: serializeWorkspaceAccessRequest(updated),
    member: {
      user_id: request.requesterUserId,
      email: request.requesterEmail,
      account_role: targetAccountRole,
      workspace_role: isAccountManager(targetAccountRole) ? null : role,
      effective_workspace_role: isAccountManager(targetAccountRole) ? 'manager' : role,
      has_implicit_access: isAccountManager(targetAccountRole),
    },
  });
},
);

// POST /v1/workspaces/:workspaceId/access-requests/:requestId/reject

workspaceRoutesApp.openapi(
  createRoute({
    method: 'post',
    path: '/{workspaceId}/access-requests/{requestId}/reject',
    tags: ['access'],
    summary: 'POST /:workspaceId/access-requests/:requestId/reject',
    ...auth,
      request: {
        params: z.object({ workspaceId: z.string(), requestId: z.string() }),
      },
    responses: {
      200: json(z.any(), 'Access request rejected'),
        ...errors(404, 409),
    },
  }),
  async (c: any) => {
  const workspaceId = c.req.param('workspaceId');
  const requestId = c.req.param('requestId');
  const loaded = await loadWorkspaceForUser(c, workspaceId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  // Reviewing an access request is membership management — gate on
  // members.manage (loadWorkspaceForUser('manage') only enforces project.write).
  await assertWorkspaceCapability(c, loaded.userId, loaded.row.accountId, workspaceId, WORKSPACE_ACTIONS.WORKSPACE_MEMBERS_MANAGE);

  const [request] = await db
    .select()
    .from(projectAccessRequests)
    .where(and(
      eq(projectAccessRequests.requestId, requestId),
      eq(projectAccessRequests.workspaceId, workspaceId),
    ))
    .limit(1);
  if (!request) return c.json({ error: 'Not found' }, 404);
  if (request.status !== 'pending') {
    return c.json({ error: 'Access request has already been reviewed' }, 409);
  }

  const [updated] = await db
    .update(projectAccessRequests)
    .set({
      status: 'rejected',
      reviewedBy: loaded.userId,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(projectAccessRequests.requestId, requestId))
    .returning();

  return c.json({ request: serializeWorkspaceAccessRequest(updated) });
},
);

// PUT /v1/workspaces/:workspaceId/access/:userId
// POST /v1/workspaces/:workspaceId/access/invite
// Invite a person to a project by email: looks up their Kortix account, ensures
// they're an org member (creating a 'member' org row if needed), then grants the
// project role. Account managers get implicit project access (no explicit grant).

workspaceRoutesApp.openapi(
  createRoute({
    method: 'post',
    path: '/{workspaceId}/access/invite',
    tags: ['access'],
    summary: 'POST /:workspaceId/access/invite',
    ...auth,
      request: {
        params: z.object({ workspaceId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        200: json(z.any(), 'OK'),
        201: json(z.any(), 'Workspace invitation created'),
        ...errors(400, 404),
    },
  }),
  async (c: any) => {
  const workspaceId = c.req.param('workspaceId');
  const loaded = await loadWorkspaceForUser(c, workspaceId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  // Inviting a member grants project access — members.manage, not plain write.
  await assertWorkspaceCapability(c, loaded.userId, loaded.row.accountId, workspaceId, WORKSPACE_ACTIONS.WORKSPACE_MEMBERS_MANAGE);

  const body = await readBody(c);
  const email = (typeof body.email === 'string' ? body.email : '').trim().toLowerCase();
  const role = normalizeWorkspaceRole(body.role);
  if (!email) return c.json({ error: 'email is required' }, 400);
  if (!role) return c.json({ error: 'role must be one of manager|editor|member' }, 400);
  const expires = parseExpiresAtBody(body.expires_at);
  if (!expires.ok) return c.json({ error: expires.error }, 400);

  const targetUserId = await lookupUserIdByEmail(email);
  if (!targetUserId) {
    // No Kortix user yet. Upsert an account invitation carrying a
    // bootstrap_grant so when they accept, they're added to the org
    // AND granted the workspace role in one step — no separate "invite
    // to org, then invite to project" dance. The unique index on
    // (account_id, email) makes this idempotent; re-inviting the
    // same email to a second project merges the grants list.
    const bootstrap = {
      project_id: workspaceId,
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
        const idx = merged.findIndex((g) => 'project_id' in g && g.project_id === workspaceId);
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
    // invites, framed around this Workspace. Fire-and-forget: the invitation row
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
        workspaceName: loaded.row.name,
      }).catch((err) => {
        console.warn('[workspaces/invite] invite email send failed:', (err as Error).message);
      });
    }

    return c.json(
      {
        status: 'invited',
        email,
        invite_id: inviteId,
        workspace_role: role,
        invite_url: buildInviteUrl(inviteId),
        // Optimistic: send is queued, not awaited. When delivery isn't wired up
        // we know synchronously it'll be skipped, so report that honestly.
        email_sent: emailConfigured,
        email_skip_reason: emailConfigured ? null : 'email_not_configured',
        message: emailConfigured
          ? `No Kortix account for that email yet — an invitation email has been sent. They'll land on this Workspace as ${role} when they sign up.`
          : `No Kortix account for that email yet — invitation created. Share the invite link with them; they'll land on this Workspace as ${role} when they sign up.`,
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
      workspace_role: null,
      effective_workspace_role: 'manager',
      has_implicit_access: true,
    });
  }

  await grantWorkspaceRole({
    accountId: loaded.row.accountId,
    workspaceId,
    userId: targetUserId,
    role,
    grantedBy: loaded.userId,
    expiresAt: expires.value,
  });

  return c.json({
    user_id: targetUserId,
    email,
    account_role: targetAccountRole,
    workspace_role: role,
    effective_workspace_role: role,
    has_implicit_access: false,
  });
},
);

// GET /v1/workspaces/:workspaceId/access/pending-invites
// Lists pending account_invitations whose bootstrap_grants target this
// project. Surfaces the "I invited someone whose email doesn't have a
// Kortix account yet" intermediate state — without this the UI looks
// the same before and after a successful invite, leaving the inviter
// to wonder if anything happened.
//
// Restricted to workspace managers — viewers don't need to see who's
// queued up for membership.

workspaceRoutesApp.openapi(
  createRoute({
    method: 'get',
    path: '/{workspaceId}/access/pending-invites',
    tags: ['access'],
    summary: 'GET /:workspaceId/access/pending-invites',
    ...auth,
      request: {
        params: z.object({ workspaceId: z.string() }),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(404),
    },
  }),
  async (c: any) => {
  const workspaceId = c.req.param('workspaceId');
  const loaded = await loadWorkspaceForUser(c, workspaceId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertWorkspaceCapability(c, loaded.userId, loaded.row.accountId, workspaceId, WORKSPACE_ACTIONS.WORKSPACE_MEMBERS_MANAGE);

  // JSONB containment check (`@>`) finds invitations whose grants array
  // contains an entry with this workspace_id. Includes expired invites in
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
        sql`${accountInvitations.bootstrapGrants} @> ${JSON.stringify([{ project_id: workspaceId }])}::jsonb`,
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
        (g) => 'project_id' in g && g.project_id === workspaceId,
      );
      // Defensive — the WHERE already filtered for project_id, but the
      // type system doesn't know that, and a corrupt row shouldn't 500.
      if (!grant || !('project_id' in grant)) return null;
      return {
        invite_id: r.inviteId,
        email: r.email,
        // Normalize a legacy `viewer`/`user` grant to `member` so the API never
        // emits a retired role.
        workspace_role: normalizeWorkspaceRole(grant.role) ?? 'member',
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

// DELETE /v1/workspaces/:workspaceId/access/pending-invites/:inviteId
// Removes this workspace's bootstrap_grant from a pending invitation. If
// that was the only grant AND the invitation is the auto-created
// "member" variety (always how project /access/invite creates them), the
// whole invitation row goes away — the user simply isn't being invited
// anywhere anymore. If the inviter had set a higher initial_role
// (admin/owner) or other project grants remain, we keep the invitation
// and just strip this workspace from it.

workspaceRoutesApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{workspaceId}/access/pending-invites/{inviteId}',
    tags: ['access'],
    summary: 'DELETE /:workspaceId/access/pending-invites/:inviteId',
    ...auth,
      request: {
        params: z.object({ workspaceId: z.string(), inviteId: z.string() }),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(404, 409),
    },
  }),
  async (c: any) => {
  const workspaceId = c.req.param('workspaceId');
  const inviteId = c.req.param('inviteId');
  const loaded = await loadWorkspaceForUser(c, workspaceId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertWorkspaceCapability(c, loaded.userId, loaded.row.accountId, workspaceId, WORKSPACE_ACTIONS.WORKSPACE_MEMBERS_MANAGE);

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
    (g) => !('project_id' in g) || g.project_id !== workspaceId,
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

// POST /v1/workspaces/:workspaceId/access/pending-invites/:inviteId/resend
// Re-sends the workspace invite email and refreshes the invitation's 14-day
// expiry. Mirrors the account-level resend, but re-frames the email around
// this workspace and reads the role from the bootstrap grant for this workspace.

workspaceRoutesApp.openapi(
  createRoute({
    method: 'post',
    path: '/{workspaceId}/access/pending-invites/{inviteId}/resend',
    tags: ['access'],
    summary: 'POST /:workspaceId/access/pending-invites/:inviteId/resend',
    ...auth,
      request: {
        params: z.object({ workspaceId: z.string(), inviteId: z.string() }),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(404, 409),
    },
  }),
  async (c: any) => {
  const workspaceId = c.req.param('workspaceId');
  const inviteId = c.req.param('inviteId');
  const loaded = await loadWorkspaceForUser(c, workspaceId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertWorkspaceCapability(c, loaded.userId, loaded.row.accountId, workspaceId, WORKSPACE_ACTIONS.WORKSPACE_MEMBERS_MANAGE);

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
    (g) => 'project_id' in g && g.project_id === workspaceId,
  );
  if (!grant || !('project_id' in grant)) {
    return c.json({ error: 'Invitation does not target this workspace' }, 404);
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
    workspaceName: loaded.row.name,
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


workspaceRoutesApp.openapi(
  createRoute({
    method: 'put',
    path: '/{workspaceId}/access/{userId}',
    tags: ['access'],
    summary: 'PUT /:workspaceId/access/:userId',
    ...auth,
      request: {
        params: z.object({ workspaceId: z.string(), userId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(400, 404),
    },
  }),
  async (c: any) => {
  const workspaceId = c.req.param('workspaceId');
  const targetUserId = c.req.param('userId');
  const loaded = await loadWorkspaceForUser(c, workspaceId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  // Member management is admin-only; loadWorkspaceForUser('manage') now
  // resolves to project.write (editor-tier), so we add an explicit
  // stricter gate here.
  await assertWorkspaceCapability(c, loaded.userId, loaded.row.accountId, workspaceId, WORKSPACE_ACTIONS.WORKSPACE_MEMBERS_MANAGE);

  const body = await readBody(c);
  const role = normalizeWorkspaceRole(body.role);
  if (!role) return c.json({ error: 'role must be one of manager|editor|member' }, 400);
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
        eq(projectMembers.workspaceId, workspaceId),
        eq(projectMembers.userId, targetUserId),
      ));
    invalidateIamCacheForUser(targetUserId);

    return c.json({
      user_id: targetUserId,
      account_role: targetAccountRole,
      workspace_role: null,
      effective_workspace_role: 'manager',
      has_implicit_access: true,
    });
  }

  await grantWorkspaceRole({
    accountId: loaded.row.accountId,
    workspaceId,
    userId: targetUserId,
    role,
    grantedBy: loaded.userId,
    expiresAt: expires.value,
  });

  return c.json({
    user_id: targetUserId,
    account_role: targetAccountRole,
    workspace_role: role,
    effective_workspace_role: role,
    has_implicit_access: false,
  });
},
);

// DELETE /v1/workspaces/:workspaceId/access/:userId

workspaceRoutesApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{workspaceId}/access/{userId}',
    tags: ['access'],
    summary: 'DELETE /:workspaceId/access/:userId',
    ...auth,
      request: {
        params: z.object({ workspaceId: z.string(), userId: z.string() }),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(404, 409),
    },
  }),
  async (c: any) => {
  const workspaceId = c.req.param('workspaceId');
  const targetUserId = c.req.param('userId');
  const loaded = await loadWorkspaceForUser(c, workspaceId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertWorkspaceCapability(c, loaded.userId, loaded.row.accountId, workspaceId, WORKSPACE_ACTIONS.WORKSPACE_MEMBERS_MANAGE);

  const targetMembership = await getAccountMembership(targetUserId, loaded.row.accountId);
  if (!targetMembership) {
    return c.json({ error: 'User is not a member of this account' }, 404);
  }

  const targetAccountRole = targetMembership.accountRole as AccountRole;
  if (isAccountManager(targetAccountRole)) {
    return c.json({ error: 'Owners and admins have implicit access to every workspace' }, 409);
  }

  await db
    .delete(projectMembers)
    .where(and(
      eq(projectMembers.workspaceId, workspaceId),
      eq(projectMembers.userId, targetUserId),
    ));
  invalidateIamCacheForUser(targetUserId);

  return c.json({ ok: true });
},
);

// ─── Workspace group grants (IAM V2 bulk-access channel) ────────────────────
//
// A row in project_group_grants attaches an account_group to a project
// with a chosen workspace role. Every member of the group inherits that
// role on that project. These routes work for both V1 and V2 accounts —
// V1 just ignores the rows because V1's engine reads from iam_policies.

// PATCH /:workspaceId/features (canonical) and /:workspaceId/experimental
// (compat alias — published SDKs call it) — set or clear a per-workspace
// feature-flag override. Auth-first (matches the other project routes), then
// validate the body — so the body schema stays permissive (AnyObject) and the
// handler returns the precise 400/403/404.
const patchFeatureFlagHandler = async (c: any) => {
  const workspaceId = c.req.param('workspaceId');
  // Strict body: malformed JSON is a client error, not an empty object —
  // readBody() would swallow the parse failure and mis-report "unknown flag".
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Request body must be a JSON object' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return c.json({ error: 'Request body must be a JSON object' }, 400);
  }
  const feature = body.feature;
  const enabled = body.enabled;
  // Floor 'read' (membership); project.customize.write is the human gate below
  // (was 'manage' → project.write, so unchecking customize.write did nothing).
  const loaded = await loadWorkspaceForUser(c, workspaceId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertWorkspaceCapability(c, loaded.userId, loaded.row.accountId, workspaceId, WORKSPACE_ACTIONS.WORKSPACE_CUSTOMIZE_WRITE);
  // Per-agent gate: toggling feature flags is workspace config. A scoped agent
  // token must hold project.customize.write (no-op for humans/PATs).
  assertAgentScope(c, WORKSPACE_ACTIONS.WORKSPACE_CUSTOMIZE_WRITE);
  if (!isFeatureFlagKey(feature)) {
    return c.json({ error: `Unknown feature flag '${feature}'` }, 400);
  }
  if (enabled !== null && typeof enabled !== 'boolean') {
    return c.json({ error: 'enabled must be a boolean or null' }, 400);
  }
  // Archived projects are read-only: reject BEFORE the write. The old order
  // (update, then 404 on archived) committed the metadata mutation anyway.
  if (loaded.row.status === 'archived') return c.json({ error: 'Not found' }, 404);
  // FIX-J: `experimental` is a NESTED object, so a whole-object `||` merge of it
  // would lose an update one level down when two flags are toggled
  // concurrently. Re-read + merge the CURRENT `experimental` sub-object in-SQL:
  // set writes only `experimental.<feature>`; clear removes it (dropping the
  // whole `experimental` key once the last override is gone). The metadata key
  // name `experimental` is a stable storage detail. Every write preserves the
  // routing pin.
  const metadataExpr =
    enabled === null
      ? metadataClearSubtreeKey('experimental', feature)
      : metadataMergeSubtree('experimental', { [feature]: enabled });
  const [row] = await db
    .update(projects)
    .set({ metadata: metadataExpr, updatedAt: new Date() })
    .where(eq(projects.workspaceId, workspaceId))
    .returning();
  if (!row) return c.json({ error: 'Not found' }, 404);
  // Convergence work (connector materialization, sandbox env fan-out) runs
  // behind the response; runFeatureFlagToggleEffects retries once and logs
  // failures at error level. See feature-flags/toggle-effects.ts.
  void runFeatureFlagToggleEffects({
    key: feature,
    workspaceId,
    accountId: row.accountId,
    metadata: row.metadata,
  });
  return c.json(serializeWorkspace(row, { workspaceRole: loaded.workspaceRole, effectiveRole: loaded.effectiveRole }));
};

for (const path of ['/{workspaceId}/features', '/{workspaceId}/experimental'] as const) {
  workspaceRoutesApp.openapi(
    createRoute({
      method: 'patch',
      path,
      tags: ['workspaces'],
      summary:
        path === '/{workspaceId}/features'
          ? 'Set or clear a per-workspace feature-flag override'
          : 'Set or clear a per-workspace feature-flag override (deprecated alias of /features)',
      ...auth,
      request: {
        params: z.object({ workspaceId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
      responses: {
        200: json(AnyObject, 'Updated workspace (with feature-flag state)'),
        ...errors(400, 401, 403, 404),
      },
    }),
    patchFeatureFlagHandler,
  );
}

// PATCH /:workspaceId/sandbox-provider — set or clear the per-workspace sandbox-provider
// pin (Customize → Settings). The value must be an ENABLED provider
// (in ALLOWED_SANDBOX_PROVIDERS and with its API key configured), or null/'' to clear
// (follow the platform default/distribution). Bypasses the distribution weights by
// design — pin a project to platinum even when platinum's weight is 0. Same auth as
// the experimental toggle (project 'manage' + project.customize.write for agents).
workspaceRoutesApp.openapi(
  createRoute({
    method: 'patch',
    path: '/{workspaceId}/sandbox-provider',
    tags: ['workspaces'],
    summary: 'Set or clear the per-workspace sandbox provider override',
    ...auth,
    request: {
      params: z.object({ workspaceId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      // FIX-L: EITHER the updated workspace (immediate) OR a preparation object
      // (prepare branch), discriminated by `kind`. Both are HTTP 200 (clients may
      // hard-check === 200); `kind` disambiguates without shape-sniffing.
      200: json(SandboxProviderPatchResultSchema, 'Updated workspace or preparation'),
      ...errors(400, 401, 403, 404),
    },
  }),
  async (c: any) => {
    const workspaceId = c.req.param('workspaceId');
    const body = await readBody(c);
    const raw = body.provider ?? body.sandbox_provider;
    // Floor 'read'; project.customize.write is the human gate below (was
    // 'manage' → project.write, so unchecking customize.write did nothing here).
    const loaded = await loadWorkspaceForUser(c, workspaceId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertWorkspaceCapability(c, loaded.userId, loaded.row.accountId, workspaceId, WORKSPACE_ACTIONS.WORKSPACE_CUSTOMIZE_WRITE);
    assertAgentScope(c, WORKSPACE_ACTIONS.WORKSPACE_CUSTOMIZE_WRITE);

    // Route the change through the durable prepare→verify→activate workflow.
    // Switching to a safe target (null clear, the platform-default provider, or
    // the already-active provider) is applied immediately and returns the
    // updated workspace (back-compat). Switching to a DIFFERENT enabled provider
    // (the Daytona→Platinum case) does NOT flip the active provider now — it
    // records a durable transition, keeps the source active for new sessions,
    // and returns a PREPARATION object the UI polls until the target image is
    // built + verified, then activated.
    try {
      const result = await requestProviderTransition({ workspaceId, targetRaw: raw });
      if (result.kind === 'immediate') {
        if (result.workspaceRow.status === 'archived') return c.json({ error: 'Not found' }, 404);
        // FIX-L: tag the immediate body with the `kind:'workspace'` discriminant so
        // the client can branch on it without shape-sniffing (the prepare body
        // already carries `kind:'preparation'` via serializeTransition).
        return c.json({
          kind: 'workspace' as const,
          ...serializeWorkspace(result.workspaceRow, {
            workspaceRole: loaded.workspaceRole,
            effectiveRole: loaded.effectiveRole,
          }),
        });
      }
      // The prepare branch's view is `serializeTransition(...)`, which already
      // carries `kind:'preparation'`.
      return c.json(result.view);
    } catch (err) {
      if (err instanceof ProviderTransitionError) {
        return c.json({ error: err.message }, err.code === 'bad_provider' ? 400 : 404);
      }
      throw err;
    }
  },
);

// GET /:workspaceId/sandbox-provider/transition — poll the durable provider-migration
// transition for this workspace. The PATCH prepare branch (Daytona→Platinum) returns
// a `kind:'preparation'` body but does NOT flip the active provider; the client
// polls this endpoint until the transition reaches a terminal status. Workspace-scoped
// (loadWorkspaceForUser rejects cross-project/non-member with a 404, same scoping as
// the PATCH). The body is a PUBLIC projection (see readPublicWorkspaceTransitionState):
// status / provider / generation / timestamps / user-safe error class only — never
// the lease epoch, lease holder, raw provider error strings, image names, or template
// ids.
workspaceRoutesApp.openapi(
  createRoute({
    method: 'get',
    path: '/{workspaceId}/sandbox-provider/transition',
    tags: ['workspaces'],
    summary: 'Poll the per-workspace sandbox-provider migration transition',
    ...auth,
    request: {
      params: z.object({ workspaceId: z.string() }),
    },
    responses: {
      200: json(SandboxProviderTransitionStateSchema, 'Public provider-transition state'),
      ...errors(401, 403, 404),
    },
  }),
  async (c: any) => {
    const workspaceId = c.req.param('workspaceId');
    const loaded = await loadWorkspaceForUser(c, workspaceId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    return c.json(await readPublicWorkspaceTransitionState(workspaceId));
  },
);
