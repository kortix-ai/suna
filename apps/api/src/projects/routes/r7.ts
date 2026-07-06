import { recordSessionAllowAll, recordSessionToolApproval } from '../../executor/db-deps';
import { isSessionVisibleTo, loadSessionGrants, parseSharingIntent, resolveShareSubject, setSessionSharing } from '../../executor/share';
import {
  PROJECT_ACTIONS,
  deleteResourceGrant,
  isCreatableResourceType,
  listResourceGrants,
  upsertResourceGrant,
} from '../../iam';
import { assertAgentScope } from '../../iam/agent-scope';
import { invalidateIamCacheForGroup } from '../../iam/cache-invalidation';
import { normalizeProjectRole } from '../../iam/role-perms';
import { projectHasResource, projectResourcesFromConfig, loadConfigWithFiles } from '../lib/project-resources';
import { auth, errors, json } from '../../openapi';
import { db } from '../../shared/db';
import { roleAllows } from '../access';
import { createRoute, z } from '@hono/zod-openapi';
import { accountGroupMembers, accountGroups, accountMembers, executorExecutions, projectGroupGrants, projectSessions, sessionSandboxes } from '@kortix/db';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { loadProjectForUser, loadVisibleSession, lookupEmailsByUserIds, parseExpiresAtBody, assertProjectCapability, isUuid } from '../lib/access';
import { AnyObject, GroupGrantSchema, OkSchema, SessionCreateAcceptedSchema, SessionSchema, projectsApp } from '../lib/app';
import { UUID_V4_REGEX, hasOwn, normalizeString, readBody, requestAuditContext, serializeSession } from '../lib/serializers';
import { sendSessionCreateError } from '../lib/sessions';
import { buildSessionTranscriptDigest } from '../lib/session-transcript';
import { syncOpenCodeTitlesForSessions } from '../opencode-title-sync';
import { createSession, deleteSession } from '../session-lifecycle';
import { requireEntitlement } from '../../accounts/iam/helpers';
import { accountHasEntitlement } from '../../billing/services/entitlements';

function parseBoundedPositiveInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  label: string,
): { ok: true; value: number } | { ok: false; error: string } {
  if (raw === undefined || raw === '') return { ok: true, value: fallback };
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    return { ok: false, error: `${label} must be an integer between ${min} and ${max}` };
  }
  return { ok: true, value };
}

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/group-grants',
    tags: ['access'],
    summary: 'GET /:projectId/group-grants',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
      },
    responses: {
        200: json(z.array(GroupGrantSchema), 'Group grants'),
        ...errors(404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const rows = await db
    .select({
      groupId: projectGroupGrants.groupId,
      role: projectGroupGrants.role,
      grantedBy: projectGroupGrants.grantedBy,
      createdAt: projectGroupGrants.createdAt,
      expiresAt: projectGroupGrants.expiresAt,
      groupName: accountGroups.name,
    })
    .from(projectGroupGrants)
    .innerJoin(accountGroups, eq(accountGroups.groupId, projectGroupGrants.groupId))
    .where(eq(projectGroupGrants.projectId, projectId))
    // Deterministic order — without ORDER BY, Postgres can return rows
    // in heap-scan order, which shifts when the row is UPDATEd (e.g., a
    // role change). The UI list would then visibly reshuffle after a
    // role flip. Oldest attachments first matches the "Attached <date>"
    // subtitle most users scan along.
    .orderBy(asc(projectGroupGrants.createdAt), asc(projectGroupGrants.groupId));

  // Per-group member breakdown so the UI can flag attachments where the
  // grant role won't apply uniformly. When a group includes account
  // owners/admins, those users have implicit Manager on every project,
  // so the group's grant role is moot for them. Surfacing
  // override_count = N lets the project admin see at a glance "this
  // Viewer attachment doesn't actually viewer-cap 3 of these 5 people".
  const groupIds = rows.map((r) => r.groupId);
  type GroupStats = { total: number; overrideCount: number };
  const statsByGroup = new Map<string, GroupStats>();
  if (groupIds.length > 0) {
    const memberRows = await db
      .select({
        groupId: accountGroupMembers.groupId,
        accountRole: accountMembers.accountRole,
        isSuperAdmin: accountMembers.isSuperAdmin,
      })
      .from(accountGroupMembers)
      .innerJoin(
        accountMembers,
        and(
          eq(accountMembers.userId, accountGroupMembers.userId),
          eq(accountMembers.accountId, loaded.row.accountId),
        ),
      )
      .where(inArray(accountGroupMembers.groupId, groupIds));
    for (const m of memberRows) {
      const stats = statsByGroup.get(m.groupId) ?? { total: 0, overrideCount: 0 };
      stats.total += 1;
      if (
        m.isSuperAdmin ||
        m.accountRole === 'owner' ||
        m.accountRole === 'admin'
      ) {
        stats.overrideCount += 1;
      }
      statsByGroup.set(m.groupId, stats);
    }
  }

  return c.json({
    grants: rows.map((r) => {
      const stats = statsByGroup.get(r.groupId) ?? { total: 0, overrideCount: 0 };
      return {
        group_id: r.groupId,
        group_name: r.groupName,
        role: r.role,
        granted_by: r.grantedBy,
        created_at: r.createdAt.toISOString(),
        /** Auto-revoke timestamp. NULL = permanent attachment. */
        expires_at: r.expiresAt?.toISOString() ?? null,
        member_count: stats.total,
        // How many of the group's members are account owners/admins —
        // their implicit Manager access overrides this grant's role.
        override_count: stats.overrideCount,
      };
    }),
  });
},
);

// POST /v1/projects/:projectId/group-grants
// Attach a group to this project at the given role. Idempotent — if the
// group already has a grant, the role is updated.

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/group-grants',
    tags: ['access'],
    summary: 'POST /:projectId/group-grants',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        201: json(GroupGrantSchema, 'The created group grant'),
        ...errors(400, 404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  // assertProjectCapability (not bare assertAuthorized) so the acting token is
  // threaded and the agent-grant fold fires: an agent-session token must also
  // hold project.members.manage to mutate group grants, not just its user.
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE);
  // Group→project grants are part of the Enterprise RBAC surface (groups are
  // gated in accounts/iam/groups.ts); gate the mutation here too so grants
  // can't be minted through the project-scoped path.
  {
    const denied = await requireEntitlement(c, loaded.row.accountId, 'rbac');
    if (denied) return denied;
  }

  const body = await readBody(c);
  const groupId = normalizeString(body.group_id ?? body.groupId);
  // normalizeProjectRole folds the legacy `viewer`/`user` aliases into `member`,
  // so a grant is never persisted with a retired role.
  const role = normalizeProjectRole(body.role);
  if (!groupId) return c.json({ error: 'group_id is required' }, 400);
  if (!role) {
    return c.json({ error: 'role must be manager, editor, or member' }, 400);
  }
  const expires = parseExpiresAtBody(body.expires_at);
  if (!expires.ok) return c.json({ error: expires.error }, 400);

  // Confirm the group exists and belongs to this account — prevents
  // attaching a foreign-account group via a guessed UUID.
  const [group] = await db
    .select({ groupId: accountGroups.groupId })
    .from(accountGroups)
    .where(
      and(eq(accountGroups.groupId, groupId), eq(accountGroups.accountId, loaded.row.accountId)),
    )
    .limit(1);
  if (!group) return c.json({ error: 'group not found in this account' }, 404);

  const now = new Date();
  await db
    .insert(projectGroupGrants)
    .values({
      projectId,
      groupId,
      accountId: loaded.row.accountId,
      role,
      grantedBy: loaded.userId,
      expiresAt: expires.value ?? null,
    })
    .onConflictDoUpdate({
      target: [projectGroupGrants.projectId, projectGroupGrants.groupId],
      set: {
        role,
        grantedBy: loaded.userId,
        updatedAt: now,
        // Only overwrite when caller explicitly set the field.
        ...(expires.value !== undefined ? { expiresAt: expires.value } : {}),
      },
    });
  await invalidateIamCacheForGroup(groupId);

  return c.json({ project_id: projectId, group_id: groupId, role }, 201);
},
);

// PATCH /v1/projects/:projectId/group-grants/:groupId
// Change the role on an existing attachment. Returns 404 when there's
// nothing to change.

projectsApp.openapi(
  createRoute({
    method: 'patch',
    path: '/{projectId}/group-grants/{groupId}',
    tags: ['access'],
    summary: 'PATCH /:projectId/group-grants/:groupId',
    ...auth,
      request: {
        params: z.object({ projectId: z.string(), groupId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(400, 404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const groupId = c.req.param('groupId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  // assertProjectCapability (not bare assertAuthorized) so the acting token is
  // threaded and the agent-grant fold fires: an agent-session token must also
  // hold project.members.manage to mutate group grants, not just its user.
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE);
  // Enterprise RBAC gate — same reasoning as the POST above. DELETE below is
  // deliberately ungated: revoking access is never paywalled, so a downgraded
  // account can always detach grants it can no longer manage.
  {
    const denied = await requireEntitlement(c, loaded.row.accountId, 'rbac');
    if (denied) return denied;
  }

  const body = await readBody(c);
  const role = normalizeProjectRole(body.role);
  if (!role) {
    return c.json({ error: 'role must be manager, editor, or member' }, 400);
  }
  const expires = parseExpiresAtBody(body.expires_at);
  if (!expires.ok) return c.json({ error: expires.error }, 400);

  const result = await db
    .update(projectGroupGrants)
    .set({
      role,
      updatedAt: new Date(),
      ...(expires.value !== undefined ? { expiresAt: expires.value } : {}),
    })
    .where(
      and(
        eq(projectGroupGrants.projectId, projectId),
        eq(projectGroupGrants.groupId, groupId),
      ),
    )
    .returning({ groupId: projectGroupGrants.groupId });

  if (result.length === 0) return c.json({ error: 'grant not found' }, 404);
  await invalidateIamCacheForGroup(groupId);
  return c.json({ project_id: projectId, group_id: groupId, role: body.role });
},
);

// DELETE /v1/projects/:projectId/group-grants/:groupId
// Detach a group. Members of the group lose access via this grant
// immediately; any direct project_members row they have is unaffected.

projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{projectId}/group-grants/{groupId}',
    tags: ['access'],
    summary: 'DELETE /:projectId/group-grants/:groupId',
    ...auth,
      request: {
        params: z.object({ projectId: z.string(), groupId: z.string() }),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const groupId = c.req.param('groupId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  // assertProjectCapability (not bare assertAuthorized) so the acting token is
  // threaded and the agent-grant fold fires: an agent-session token must also
  // hold project.members.manage to mutate group grants, not just its user.
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE);

  await db
    .delete(projectGroupGrants)
    .where(
      and(
        eq(projectGroupGrants.projectId, projectId),
        eq(projectGroupGrants.groupId, groupId),
      ),
    );
  await invalidateIamCacheForGroup(groupId);

  return c.json({ ok: true });
},
);

// Session routes. Invariant: session_id == sandbox_id == git branch name.

// POST /v1/projects/:projectId/sessions

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/sessions',
    tags: ['sessions'],
    summary: 'POST /:projectId/sessions',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        201: json(SessionSchema, 'The created session'),
        202: json(SessionCreateAcceptedSchema, 'Create accepted; poll the session'),
        ...errors(404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const body = await readBody(c);
  const loaded = await loadProjectForUser(c, projectId, 'session');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  // Per-agent gate: starting a session provisions compute. A scoped agent token
  // must hold project.session.start (no-op for human/PAT tokens).
  assertAgentScope(c, PROJECT_ACTIONS.PROJECT_SESSION_START);
  // Per-RESOURCE scoping: a member/department can only launch agents they're
  // scoped to. No-op when the agent isn't scoped (unscoped = project-wide) and
  // for owner/admins. Mirrors the agent the session core resolves (sessions.ts).
  const launchAgent = normalizeString(body.agent_name ?? body.agentName);
  if (launchAgent) {
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_AGENT_READ,
      { type: 'agent', id: launchAgent },
    );
  }
  const result = await createSession({
    source: 'ui',
    project: loaded.row,
    userId: loaded.userId,
    body,
    request: requestAuditContext(c),
    idempotencyKey: c.req.header('idempotency-key') ?? null,
  });
  if (result.error) return sendSessionCreateError(c, result.error);
  for (const [key, value] of Object.entries(result.headers ?? {})) {
    c.header(key, value);
  }
  if (!result.row) {
    return c.json(
      {
        status: result.status,
        command_id: result.commandId ?? null,
        session_id: result.sessionId ?? null,
        reason: result.reason ?? null,
      },
      202,
    );
  }
  return c.json(
      serializeSession(result.row, {
      viewerId: loaded.userId,
      canManageProject: roleAllows(loaded.effectiveRole, 'manage'),
    }),
    201,
  );
},
);

// GET /v1/projects/:projectId/sessions

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/sessions',
    tags: ['sessions'],
    summary: 'GET /:projectId/sessions',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
      },
    responses: {
        200: json(z.array(SessionSchema), 'Sessions'),
        ...errors(404),
    },
  }),
  async (c) => {
  const projectId = c.req.param('projectId');

  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_SESSION_READ);

  const rows = await db
    .select()
    .from(projectSessions)
    .where(and(eq(projectSessions.projectId, projectId), eq(projectSessions.accountId, loaded.row.accountId)))
    .orderBy(desc(projectSessions.updatedAt));

  const resumableStoppedSessionIds = rows.length
    ? new Set(
        (
          await db
            .select({ sessionId: sessionSandboxes.sessionId })
            .from(sessionSandboxes)
            .where(
              and(
                eq(sessionSandboxes.projectId, projectId),
                eq(sessionSandboxes.accountId, loaded.row.accountId),
                eq(sessionSandboxes.status, 'stopped'),
                inArray(sessionSandboxes.sessionId, rows.map((r) => r.sessionId)),
              ),
            )
        )
          .map((r) => r.sessionId)
          .filter((id): id is string => !!id),
      )
    : new Set<string>();

  const listableRows = rows.filter((r) => {
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    if (typeof meta.deletedAt === 'string') return false;
    return r.status !== 'stopped' || resumableStoppedSessionIds.has(r.sessionId);
  });

  // Filter to sessions the viewer may see: their own, project-wide, or ones
  // shared with them (restricted + grant). Then surface owner + sharing so the
  // list can show "shared by X".
  const subject = await resolveShareSubject(loaded.userId);
  const canManageProject = roleAllows(loaded.effectiveRole, 'manage');
  const grantsBySession = await loadSessionGrants(
    listableRows.filter((r) => r.visibility === 'restricted').map((r) => r.sessionId),
  );
  let visible = listableRows.filter((r) =>
    isSessionVisibleTo(
      r.visibility as 'private' | 'project' | 'restricted',
      r.createdBy,
      grantsBySession.get(r.sessionId) ?? [],
      subject,
    ),
  );
  visible = await syncOpenCodeTitlesForSessions({
    rows: visible,
    projectId,
    accountId: loaded.row.accountId,
    userId: loaded.userId,
  });
  // Owner emails only for sessions someone else owns (for the "shared by" label).
  const ownerIds = [...new Set(visible.map((r) => r.createdBy).filter((id): id is string => !!id && id !== loaded.userId))];
  const emails = await lookupEmailsByUserIds(ownerIds);

  return c.json(
    visible.map((r) =>
      serializeSession(r, {
        grants: grantsBySession.get(r.sessionId) ?? [],
        viewerId: loaded.userId,
        canManageProject,
        ownerEmail: r.createdBy ? emails.get(r.createdBy) ?? null : null,
      }),
    ),
  );
},
);

// GET /v1/projects/:projectId/sessions/:sessionId

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/sessions/{sessionId}',
    tags: ['sessions'],
    summary: 'GET /:projectId/sessions/:sessionId',
    ...auth,
      request: {
        params: z.object({ projectId: z.string(), sessionId: z.string() }),
      },
    responses: {
        200: json(SessionSchema, 'The session'),
        ...errors(400, 404),
    },
  }),
  async (c) => {
  const projectId = c.req.param('projectId');
  const sessionId = c.req.param('sessionId');
  if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_SESSION_READ);

  const visible = await loadVisibleSession(loaded, sessionId);
  if (!visible) return c.json({ error: 'Not found' }, 404);
  const [row] = await syncOpenCodeTitlesForSessions({
    rows: [visible.row],
    projectId,
    accountId: loaded.row.accountId,
    userId: loaded.userId,
  });

  const ownerEmail = visible.row.createdBy && !visible.isOwner
    ? (await lookupEmailsByUserIds([visible.row.createdBy])).get(visible.row.createdBy) ?? null
    : null;
  return c.json(serializeSession(row ?? visible.row, {
    grants: visible.grants,
    viewerId: loaded.userId,
    canManageProject: visible.canManageProject,
    ownerEmail,
  }));
},
);


// GET /v1/projects/:projectId/sessions/:sessionId/transcript
// Compact server-side transcript read for project automation. Unlike the raw
// /v1/p sandbox proxy, this endpoint is callable with project-scoped session
// tokens and strips tool inputs/outputs before returning messages.

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/sessions/{sessionId}/transcript',
    tags: ['sessions'],
    summary: 'GET /:projectId/sessions/:sessionId/transcript',
    ...auth,
      request: {
        params: z.object({ projectId: z.string(), sessionId: z.string() }),
        query: z.object({
          limit: z.string().optional(),
          chars: z.string().optional(),
        }),
      },
    responses: {
        200: json(AnyObject, 'Compact session transcript'),
        ...errors(400, 404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const sessionId = c.req.param('sessionId');
  if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

  const limit = parseBoundedPositiveInt(c.req.query('limit'), 40, 1, 500, 'limit');
  if (!limit.ok) return c.json({ error: limit.error }, 400);
  const maxChars = parseBoundedPositiveInt(c.req.query('chars'), 700, 80, 5000, 'chars');
  if (!maxChars.ok) return c.json({ error: maxChars.error }, 400);

  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_SESSION_READ);

  const visible = await loadVisibleSession(loaded, sessionId);
  if (!visible) return c.json({ error: 'Not found' }, 404);

  const transcript = await buildSessionTranscriptDigest({
    session: visible.row,
    projectId,
    accountId: loaded.row.accountId,
    userId: loaded.userId,
    limit: limit.value,
    maxChars: maxChars.value,
  });
  return c.json(transcript);
},
);


// GET /v1/projects/:projectId/sessions/:sessionId/audit
// Per-session audit log — the governed actions an agent took in this session:
// every connector/tool call the executor gated, with its risk, allow/ask/block
// verdict, who acted, and (for approvals) who resolved it. This is the enterprise
// "what did the agent actually do" trail, read straight from executor_executions.
// Same visibility gate as the session detail/transcript (project read + the
// session must be visible to the caller). Non-Enterprise accounts get only the
// unresolved pending approvals (never a 402 — see the entitlement note below).

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/sessions/{sessionId}/audit',
    tags: ['sessions'],
    summary: 'GET /:projectId/sessions/:sessionId/audit',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), sessionId: z.string() }),
      query: z.object({ limit: z.string().optional() }),
    },
    responses: {
      200: json(AnyObject, 'Per-session agent action audit log'),
      ...errors(400, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

    const limit = parseBoundedPositiveInt(c.req.query('limit'), 200, 1, 1000, 'limit');
    if (!limit.ok) return c.json({ error: limit.error }, 400);

    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_SESSION_READ);
    const visible = await loadVisibleSession(loaded, sessionId);
    if (!visible) return c.json({ error: 'Not found' }, 404);
    // The historical trail is Enterprise (`auditAccess`), but this endpoint is
    // also the approval CONTROL PLANE: write/destructive connector actions
    // default to require_approval on every tier (executor/policy.ts), the web
    // app polls this route from every open session to render the approval
    // prompt, and it is the launcher's only view of what's blocking the run.
    // A 402 here breaks approvals for every non-Enterprise account (and toasts
    // the upsell on each poll) — so unentitled accounts degrade to unresolved
    // pending approvals only instead of being denied.
    const audited = await accountHasEntitlement(loaded.row.accountId, 'auditAccess');

    const rows = await db
      .select({
        executionId: executorExecutions.executionId,
        connectorId: executorExecutions.connectorId,
        actionPath: executorExecutions.actionPath,
        actingUserId: executorExecutions.actingUserId,
        status: executorExecutions.status,
        risk: executorExecutions.risk,
        resultSummary: executorExecutions.resultSummary,
        approvedBy: executorExecutions.approvedBy,
        createdAt: executorExecutions.createdAt,
        resolvedAt: executorExecutions.resolvedAt,
      })
      .from(executorExecutions)
      .where(
        and(
          eq(executorExecutions.projectId, projectId),
          eq(executorExecutions.sessionId, sessionId),
          ...(audited
            ? []
            : [
                eq(executorExecutions.status, 'pending_approval'),
                isNull(executorExecutions.approvedBy),
                isNull(executorExecutions.resolvedAt),
              ]),
        ),
      )
      // Most-recent-first: when a busy session exceeds `limit`, keep the RECENT
      // actions (truncating oldest), not the other way round.
      .orderBy(desc(executorExecutions.createdAt))
      .limit(limit.value);

    // Resolve actor + approver emails in one batched lookup (managers see who).
    const userIds = [
      ...new Set(rows.flatMap((r) => [r.actingUserId, r.approvedBy]).filter((v): v is string => !!v)),
    ];
    const emailByUser = userIds.length ? await lookupEmailsByUserIds(userIds) : new Map<string, string>();

    return c.json({
      session_id: sessionId,
      agent: (visible.row.agentName as string | null) ?? null,
      // False when the account lacks the Enterprise `auditAccess` entitlement:
      // `actions` then contains only unresolved pending approvals, and the UI
      // shows the upgrade path for the full trail.
      audit_access: audited,
      count: rows.length,
      // Most-recent-first trail of every executor-gated action this session took.
      actions: rows.map((r) => ({
        execution_id: r.executionId,
        action: r.actionPath,
        connector_id: r.connectorId,
        status: r.status, // ok | error | denied | pending_approval
        risk: r.risk, // read | write | destructive | null
        acted_by: r.actingUserId,
        acted_by_email: r.actingUserId ? emailByUser.get(r.actingUserId) ?? null : null,
        // Who resolved a gated action — set for BOTH approve and deny (the
        // approvedBy column doubles as "resolver"). null while still pending.
        resolved_by: r.approvedBy,
        resolved_by_email: r.approvedBy ? emailByUser.get(r.approvedBy) ?? null : null,
        result_summary: r.resultSummary ?? null,
        at: r.createdAt.toISOString(),
        resolved_at: r.resolvedAt?.toISOString() ?? null,
      })),
    });
  },
);


// GET /v1/projects/:projectId/approvals
// The approval inbox: executor actions a policy gated as `require_approval` that
// are still awaiting a human decision (status=pending_approval, unresolved).
// Manager-scoped — this is the project-wide oversight surface. A session's own
// launcher also sees + resolves the pending items for their session via the
// per-session audit view + the POST below.

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/approvals',
    tags: ['access'],
    summary: 'GET /:projectId/approvals',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      query: z.object({ limit: z.string().optional() }),
    },
    responses: {
      200: json(AnyObject, 'Pending approval inbox'),
      ...errors(400, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'manage');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE);

    const limit = parseBoundedPositiveInt(c.req.query('limit'), 100, 1, 500, 'limit');
    if (!limit.ok) return c.json({ error: limit.error }, 400);

    const rows = await db
      .select({
        executionId: executorExecutions.executionId,
        actionPath: executorExecutions.actionPath,
        risk: executorExecutions.risk,
        sessionId: executorExecutions.sessionId,
        actingUserId: executorExecutions.actingUserId,
        resultSummary: executorExecutions.resultSummary,
        createdAt: executorExecutions.createdAt,
      })
      .from(executorExecutions)
      .where(
        and(
          eq(executorExecutions.projectId, projectId),
          eq(executorExecutions.status, 'pending_approval'),
          isNull(executorExecutions.approvedBy),
          isNull(executorExecutions.resolvedAt),
        ),
      )
      .orderBy(desc(executorExecutions.createdAt))
      .limit(limit.value);

    const userIds = [...new Set(rows.map((r) => r.actingUserId).filter((v): v is string => !!v))];
    const emailByUser = userIds.length ? await lookupEmailsByUserIds(userIds) : new Map<string, string>();

    return c.json({
      count: rows.length,
      approvals: rows.map((r) => ({
        execution_id: r.executionId,
        action: r.actionPath,
        risk: r.risk,
        session_id: r.sessionId,
        requested_by: r.actingUserId,
        requested_by_email: r.actingUserId ? emailByUser.get(r.actingUserId) ?? null : null,
        requested_at: r.createdAt.toISOString(),
        detail: r.resultSummary ?? null,
      })),
    });
  },
);

// GET /v1/projects/:projectId/approvals/needs-input
// Lightweight per-session summary for the sidebar "needs input" indicator: which
// sessions have an executor action awaiting a human decision, and how many. A
// project MANAGER sees every session; everyone else sees only the sessions they
// LAUNCHED (mirrors who may resolve). Read-gated + cheap enough to poll.

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/approvals/needs-input',
    tags: ['access'],
    summary: 'GET /:projectId/approvals/needs-input',
    ...auth,
    request: { params: z.object({ projectId: z.string() }) },
    responses: {
      200: json(AnyObject, 'Sessions awaiting a human decision'),
      ...errors(400, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);

    // Managers see every session's pending items; others only their own launched
    // sessions (same principal set the resolve endpoint accepts).
    let isManager = false;
    try {
      await assertProjectCapability(
        c,
        loaded.userId,
        loaded.row.accountId,
        projectId,
        PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE,
      );
      isManager = true;
    } catch {
      isManager = false;
    }

    // Every unresolved pending action in the project, by session. (No DB join:
    // executor_executions.session_id is `uuid` while project_sessions.session_id
    // is `text` — cross-type equality errors in Postgres, so we resolve in JS
    // where both surface as strings.)
    const pendingRows = await db
      .select({ sessionId: executorExecutions.sessionId })
      .from(executorExecutions)
      .where(
        and(
          eq(executorExecutions.projectId, projectId),
          eq(executorExecutions.status, 'pending_approval'),
          isNull(executorExecutions.approvedBy),
          isNull(executorExecutions.resolvedAt),
        ),
      );

    // Count per (Kortix) session id.
    const byKortix: Record<string, number> = {};
    for (const r of pendingRows) {
      const sid = r.sessionId ? String(r.sessionId) : null;
      if (sid) byKortix[sid] = (byKortix[sid] ?? 0) + 1;
    }
    const kortixIds = Object.keys(byKortix);
    if (kortixIds.length === 0) return c.json({ total: 0, sessions: {} });

    // Look these sessions up to (a) gate non-managers to their own and (b) map to
    // the OpenCode session id the sidebar list keys on. The response carries BOTH
    // id forms → the caller matches whichever it holds.
    const sess = await db
      .select({
        sessionId: projectSessions.sessionId,
        opencodeSessionId: projectSessions.opencodeSessionId,
        createdBy: projectSessions.createdBy,
      })
      .from(projectSessions)
      .where(and(eq(projectSessions.projectId, projectId), inArray(projectSessions.sessionId, kortixIds)));

    const sessions: Record<string, number> = {};
    let total = 0;
    for (const s of sess) {
      if (!isManager && s.createdBy !== loaded.userId) continue;
      const n = byKortix[s.sessionId] ?? 0;
      if (n <= 0) continue;
      sessions[s.sessionId] = n;
      if (s.opencodeSessionId) sessions[s.opencodeSessionId] = n;
      total += n;
    }
    return c.json({ total, sessions });
  },
);

// POST /v1/projects/:projectId/approvals/:executionId
// Resolve a pending approval — { decision: 'approve' | 'deny' }. Allowed for a
// project MANAGER or the LAUNCHER of the session the action belongs to (the two
// principals a human-in-the-loop approval should recognise). Records who decided
// + when; idempotent-safe (a non-pending row 409s).

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/approvals/{executionId}',
    tags: ['access'],
    summary: 'POST /:projectId/approvals/:executionId',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), executionId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      200: json(OkSchema, 'Resolved'),
      ...errors(400, 403, 404, 409),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const executionId = c.req.param('executionId');
    if (!isUuid(executionId)) return c.json({ error: 'Invalid execution id' }, 400);
    const body = await readBody(c);
    const decision = normalizeString(body.decision);
    if (decision !== 'approve' && decision !== 'deny') {
      return c.json({ error: "decision must be 'approve' or 'deny'" }, 400);
    }
    // 'once' (default) = approve just this call; 'session' = also stop asking for
    // THIS connector+action for the rest of the session; 'session_all' = stop
    // asking for EVERY action for the rest of the session (blanket allow-all).
    // Only meaningful on approve. (A policy `block` never reaches this endpoint
    // as pending, so these can only ever widen require_approval → run.)
    const rawScope = normalizeString(body.scope);
    const scope =
      rawScope === 'session' ? 'session' : rawScope === 'session_all' ? 'session_all' : 'once';

    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);

    const [row] = await db
      .select({
        executionId: executorExecutions.executionId,
        sessionId: executorExecutions.sessionId,
        connectorId: executorExecutions.connectorId,
        actionPath: executorExecutions.actionPath,
        status: executorExecutions.status,
        approvedBy: executorExecutions.approvedBy,
        resolvedAt: executorExecutions.resolvedAt,
        resultSummary: executorExecutions.resultSummary,
      })
      .from(executorExecutions)
      .where(and(eq(executorExecutions.executionId, executionId), eq(executorExecutions.projectId, projectId)))
      .limit(1);
    if (!row) return c.json({ error: 'Not found' }, 404);
    if (row.status !== 'pending_approval' || row.approvedBy || row.resolvedAt) {
      return c.json({ error: 'Approval already resolved' }, 409);
    }

    // Who may resolve: a project MANAGER (the same project.members.manage IAM
    // gate the inbox uses — capability-consistent, so a custom role holding the
    // leaf without the "manager" label still qualifies), OR the human who
    // launched the session the gated action belongs to. (Founder decision:
    // managers + launcher.) assertProjectCapability throws on denial, so probe
    // it — a non-manager launcher must still fall through.
    let isManager = false;
    try {
      await assertProjectCapability(
        c,
        loaded.userId,
        loaded.row.accountId,
        projectId,
        PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE,
      );
      isManager = true;
    } catch {
      isManager = false;
    }
    let isLauncher = false;
    if (!isManager && row.sessionId) {
      const [session] = await db
        .select({ createdBy: projectSessions.createdBy })
        .from(projectSessions)
        // Scope to THIS project too — sessionId is a PK so it's globally unique,
        // but making the project bound explicit keeps the gate self-documenting.
        .where(and(eq(projectSessions.sessionId, row.sessionId), eq(projectSessions.projectId, projectId)))
        .limit(1);
      isLauncher = Boolean(session && session.createdBy === loaded.userId);
    }
    if (!isManager && !isLauncher) {
      return c.json({ error: 'Only a project manager or the session launcher can resolve this' }, 403);
    }

    const detail = {
      ...(typeof row.resultSummary === 'object' && row.resultSummary ? row.resultSummary : {}),
      decision,
      decided_by: loaded.userId,
    };
    // Atomic resolve — guard the UPDATE on the still-pending state so two
    // concurrent resolvers can't both win (TOCTOU): approve clears the gate to
    // the terminal `ok` (the real retried call re-audits as its own row), deny
    // flips it to `denied`. Both stamp approvedBy (= who resolved) + resolvedAt,
    // so the row leaves the pending inbox. A lost race matches 0 rows → 409.
    const resolved = await db
      .update(executorExecutions)
      .set({
        status: decision === 'approve' ? 'ok' : 'denied',
        approvedBy: loaded.userId,
        resolvedAt: new Date(),
        resultSummary: detail,
      })
      .where(
        and(
          eq(executorExecutions.executionId, executionId),
          eq(executorExecutions.projectId, projectId),
          eq(executorExecutions.status, 'pending_approval'),
          isNull(executorExecutions.approvedBy),
          isNull(executorExecutions.resolvedAt),
        ),
      )
      .returning({ id: executorExecutions.executionId });

    if (resolved.length === 0) {
      return c.json({ error: 'Approval already resolved' }, 409);
    }

    // "Allow for this session": record (session, connector, action) so the
    // gateway auto-runs the same tool for the rest of the session. Best-effort +
    // idempotent — a failure here doesn't undo the (already-committed) approval.
    if (decision === 'approve' && scope === 'session' && row.sessionId && row.connectorId) {
      try {
        await recordSessionToolApproval({
          sessionId: row.sessionId,
          projectId,
          connectorId: row.connectorId,
          actionPath: row.actionPath,
          grantedBy: loaded.userId,
        });
      } catch (err) {
        console.warn('[approvals] failed to record session allow', {
          executionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // "Allow ALL for this session": one blanket grant so the gateway auto-runs
    // every gated tool for the rest of the session. Best-effort + idempotent.
    if (decision === 'approve' && scope === 'session_all' && row.sessionId) {
      try {
        await recordSessionAllowAll({
          sessionId: row.sessionId,
          projectId,
          grantedBy: loaded.userId,
        });
      } catch (err) {
        console.warn('[approvals] failed to record session allow-all', {
          executionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return c.json({ ok: true, scope });
  },
);


// PUT /v1/projects/:projectId/sessions/:sessionId/sharing
// Owner or project manager sets who can see/open this session
// (private | project | members). Mirrors connector/secret sharing.

projectsApp.openapi(
  createRoute({
    method: 'put',
    path: '/{projectId}/sessions/{sessionId}/sharing',
    tags: ['sessions'],
    summary: 'PUT /:projectId/sessions/:sessionId/sharing',
    ...auth,
      request: {
        params: z.object({ projectId: z.string(), sessionId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(400, 403, 404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const sessionId = c.req.param('sessionId');
  if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

  const body = await readBody(c);
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const visible = await loadVisibleSession(loaded, sessionId);
  if (!visible) return c.json({ error: 'Not found' }, 404);
  if (!visible.canManageSharing) {
    return c.json({ error: 'Only the session owner or a project manager can change sharing' }, 403);
  }

  const intent = parseSharingIntent(body, loaded.userId);
  if (!intent) return c.json({ error: 'invalid sharing — mode must be project|private|members' }, 400);

  await setSessionSharing(sessionId, intent);

  const fresh = await loadVisibleSession(loaded, sessionId);
  return c.json(fresh ? serializeSession(fresh.row, {
    grants: fresh.grants,
    viewerId: loaded.userId,
    canManageProject: fresh.canManageProject,
  }) : { ok: true });
},
);

// PATCH /v1/projects/:projectId/sessions/:sessionId

projectsApp.openapi(
  createRoute({
    method: 'patch',
    path: '/{projectId}/sessions/{sessionId}',
    tags: ['sessions'],
    summary: 'PATCH /:projectId/sessions/:sessionId',
    ...auth,
      request: {
        params: z.object({ projectId: z.string(), sessionId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        200: json(SessionSchema, 'The updated session'),
        ...errors(400, 404),
    },
  }),
  async (c) => {
  const projectId = c.req.param('projectId');
  const sessionId = c.req.param('sessionId');
  if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

  const body = await readBody(c);
  const loaded = await loadProjectForUser(c, projectId, 'session');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const serverManagedFields = ['status', 'sandbox_url', 'sandboxUrl', 'error'];
  const attemptedServerField = serverManagedFields.find((field) => hasOwn(body, field));
  if (attemptedServerField) {
    return c.json({ error: `field is server-managed: ${attemptedServerField}` }, 400);
  }

  // opencode_session_id is SERVER-MANAGED: the backend is the sole authority
  // for the OpenCode↔Kortix mapping (see ensure-opencode + opencode-mapping.ts).
  // Clients must never set it, so a stale/forged client value can't drift it.
  const opencodeManagedField = ['opencode_session_id', 'opencodeSessionId'].find((f) => hasOwn(body, f));
  if (opencodeManagedField) {
    return c.json({ error: `field is server-managed: ${opencodeManagedField}` }, 400);
  }

  const allowedFields = ['name', 'metadata'];
  const unknownField = Object.keys(body).find((field) => !allowedFields.includes(field));
  if (unknownField) {
    return c.json({ error: `field is not user-editable: ${unknownField}` }, 400);
  }

  const visible = await loadVisibleSession(loaded, sessionId);
  if (!visible) return c.json({ error: 'Not found' }, 404);
  const existing = visible.row;

  const updates: Partial<typeof projectSessions.$inferInsert> = { updatedAt: new Date() };

  // A user-set name is the AUTHORITATIVE display name. It lives in
  // metadata.custom_name — a separate key from metadata.name (the server-side
  // auto title mirrored from OpenCode during session reads) so a rename is never
  // clobbered by a later sync. Passing name: "" (or null) clears the override
  // and reverts the session to its auto title.
  const hasNameField = hasOwn(body, 'name');
  const name = normalizeString(body.name);
  const metadata = body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
    ? body.metadata as Record<string, unknown>
    : null;

  if (hasNameField || metadata) {
    const nextMetadata: Record<string, unknown> = {
      ...(existing.metadata ?? {}),
      ...(metadata ?? {}),
    };
    if (hasNameField) {
      if (name) nextMetadata.custom_name = name;
      else delete nextMetadata.custom_name;
    }
    updates.metadata = nextMetadata;
  }

  const [row] = await db
    .update(projectSessions)
    .set(updates)
    .where(and(
      eq(projectSessions.sessionId, sessionId),
      eq(projectSessions.projectId, projectId),
      eq(projectSessions.accountId, loaded.row.accountId),
    ))
    .returning();

  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json(serializeSession(row, {
    grants: visible.grants,
    viewerId: loaded.userId,
    canManageProject: visible.canManageProject,
  }));
},
);

// DELETE /v1/projects/:projectId/sessions/:sessionId
// Soft delete only. We deliberately keep the remote branch so the user can
// still merge or recover work.

projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{projectId}/sessions/{sessionId}',
    tags: ['sessions'],
    summary: 'DELETE /:projectId/sessions/:sessionId',
    ...auth,
      request: {
        params: z.object({ projectId: z.string(), sessionId: z.string() }),
      },
    responses: {
        200: json(OkSchema, 'Session stopped'),
        ...errors(400, 403, 404),
    },
  }),
  async (c) => {
  const projectId = c.req.param('projectId');
  const sessionId = c.req.param('sessionId');
  if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

  const loaded = await loadProjectForUser(c, projectId, 'session');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  // Per-agent gate: tearing down a session. A scoped agent token must hold
  // project.session.stop (no-op for human/PAT tokens).
  assertAgentScope(c, PROJECT_ACTIONS.PROJECT_SESSION_STOP);

  // Stopping a session is reserved for its owner or a project manager.
  const visible = await loadVisibleSession(loaded, sessionId);
  if (!visible) return c.json({ error: 'Not found' }, 404);
  if (!visible.canManageSharing) {
    return c.json({ error: 'Only the session owner or a project manager can stop this session' }, 403);
  }

  const result = await deleteSession({
    projectId,
    sessionId,
    accountId: loaded.row.accountId,
    userId: loaded.userId,
    metadata: visible.row.metadata,
  });
  if ('error' in result) return c.json({ error: result.error }, result.status as any);
  return c.json(result);
},
);

// ─── Per-resource (agent/skill) scoping ─────────────────────────────────────
// Scope a member or group to SPECIFIC agents/skills. A resource with >=1 grant
// is visible/usable only to granted principals; unscoped resources stay
// project-wide. All three routes gate on project.members.manage (same as the
// group-grant routes) and thread the acting token so the agent-grant fold fires.

// GET /v1/projects/:projectId/resource-grants
// Returns the project's grantable resources (for the picker) + every grant,
// each enriched with a principal label so the UI needn't re-join.
projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/resource-grants',
    tags: ['access'],
    summary: 'GET /:projectId/resource-grants',
    ...auth,
    request: { params: z.object({ projectId: z.string() }) },
    responses: { 200: json(z.any(), 'Resource grants + grantable resources'), ...errors(404) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'manage');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    // Manager-only: this is the grant PICKER — it returns the FULL agent/skill
    // catalogue + granted-member emails, so it must NOT be readable by a scoped
    // member (who'd otherwise enumerate exactly what they were scoped away from).
    // Gate identical to the POST/DELETE siblings below.
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE);

    // Enumerate grantable resources from the project config (best-effort: a repo
    // that won't load just yields empty lists — the existing grants still show).
    let resources: {
      // Agents carry their DECLARED scope so the grant UI can preview the blast
      // radius — "assigning this agent also grants these secrets + connectors"
      // (the inheritance pyramid). `'all'` = every secret/connector the assignee
      // can already see (nothing extra inherited).
      agents: {
        id: string;
        name: string;
        declares?: { secrets: string[] | 'all'; connectors: string[] | 'all' };
      }[];
      skills: { id: string; name: string }[];
    } = { agents: [], skills: [] };
    let configLoaded = false;
    try {
      const config = await loadConfigWithFiles(loaded.row);
      const fromConfig = projectResourcesFromConfig(config);
      const scopeByAgent = new Map(config.agents.map((a) => [a.name, a.scope]));
      resources.agents = fromConfig.agents.map((a) => ({
        ...a,
        declares: {
          secrets: scopeByAgent.get(a.id)?.env ?? 'all',
          connectors: scopeByAgent.get(a.id)?.connectors ?? 'all',
        },
      }));
      resources.skills = fromConfig.skills;
      configLoaded = true;
    } catch (err) {
      console.warn('[resource-grants] config load failed', {
        projectId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // Grants key on the agent NAME / skill SLUG. A rename or delete of the
    // underlying resource leaves the grant ORPHANED — and since an unscoped
    // resource is project-wide, the restriction silently evaporates. Flag
    // orphaned grants so the manager gets a SIGNAL to re-grant.
    // Only checked when the config actually loaded (a transient repo failure
    // must not mass-flag).
    const liveAgentIds = new Set(resources.agents.map((r) => r.id));
    const liveSkillIds = new Set(resources.skills.map((r) => r.id));
    const isOrphan = (type: string, id: string) => {
      if (!configLoaded) return false;
      return type === 'agent' ? !liveAgentIds.has(id) : type === 'skill' ? !liveSkillIds.has(id) : false;
    };

    // Agents/skills come from iam_resource_grants. SECRETS no longer have a
    // resource-type here — secret sharing was retired (a secret is always
    // project-wide; the only access gate is the agent-side `secrets` grant).
    const grants = (await listResourceGrants(projectId)).filter((g) => g.resourceType !== 'secret');

    // Resolve principal labels in two batched lookups.
    const memberIds = [...new Set(grants.filter((g) => g.principalType === 'member').map((g) => g.principalId))];
    const groupIds = [...new Set(grants.filter((g) => g.principalType === 'group').map((g) => g.principalId))];
    const emailByUser = memberIds.length ? await lookupEmailsByUserIds(memberIds) : new Map<string, string>();
    const groupNameById = new Map<string, string>();
    if (groupIds.length) {
      const groupRows = await db
        .select({ groupId: accountGroups.groupId, name: accountGroups.name })
        .from(accountGroups)
        .where(and(eq(accountGroups.accountId, loaded.row.accountId), inArray(accountGroups.groupId, groupIds)));
      for (const g of groupRows) groupNameById.set(g.groupId, g.name);
    }

    return c.json({
      resources,
      grants: grants.map((g) => ({
        grant_id: g.grantId,
        resource_type: g.resourceType,
        resource_id: g.resourceId,
        principal_type: g.principalType,
        principal_id: g.principalId,
        principal_label:
          g.principalType === 'member'
            ? emailByUser.get(g.principalId) ?? g.principalId
            : groupNameById.get(g.principalId) ?? g.principalId,
        granted_by: g.grantedBy,
        created_at: g.createdAt.toISOString(),
        expires_at: g.expiresAt?.toISOString() ?? null,
        // true = the agent/skill this grant scopes no longer exists (renamed or
        // deleted); the grant is inert and should be removed or re-pointed.
        orphaned: isOrphan(g.resourceType, g.resourceId),
      })),
    });
  },
);

// POST /v1/projects/:projectId/resource-grants
// Create/update a grant (idempotent on resource+principal). Validates the
// resource exists in the project and the principal belongs to this account.
projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/resource-grants',
    tags: ['access'],
    summary: 'POST /:projectId/resource-grants',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: { 201: json(z.any(), 'The created grant'), ...errors(400, 404) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'manage');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE);

    const body = await readBody(c);
    const resourceType = normalizeString(body.resource_type ?? body.resourceType);
    const resourceId = normalizeString(body.resource_id ?? body.resourceId);
    const principalType = normalizeString(body.principal_type ?? body.principalType);
    const principalId = normalizeString(body.principal_id ?? body.principalId);
    // AGENT-ONLY resource model: agent is the only member/department-scoped
    // resource. Skills and secrets are governed by the editor role (edit) +
    // agent inheritance (use) — no NEW skill/secret grant may be created here.
    // Pre-existing skill/secret rows still read/list/revoke fine (see
    // resource-grants.ts's RESOURCE_GRANT_TYPES doc comment).
    if (!resourceType || !isCreatableResourceType(resourceType)) {
      return c.json({ error: 'resource_type must be agent' }, 400);
    }
    if (!resourceId) return c.json({ error: 'resource_id is required' }, 400);
    if (principalType !== 'member' && principalType !== 'group') {
      return c.json({ error: 'principal_type must be member or group' }, 400);
    }
    if (!principalId) return c.json({ error: 'principal_id is required' }, 400);
    // principal_id flows into a uuid column — validate the shape first so a
    // malformed value is a clean 400, not a 22P02 500.
    if (!isUuid(principalId)) return c.json({ error: 'principal_id must be a valid id' }, 400);
    const expires = parseExpiresAtBody(body.expires_at);
    if (!expires.ok) return c.json({ error: expires.error }, 400);

    // The principal must belong to THIS account — never grant a foreign member/
    // group via a guessed id.
    if (principalType === 'member') {
      const [m] = await db
        .select({ userId: accountMembers.userId })
        .from(accountMembers)
        .where(and(eq(accountMembers.accountId, loaded.row.accountId), eq(accountMembers.userId, principalId)))
        .limit(1);
      if (!m) return c.json({ error: 'member not found in this account' }, 404);
    } else {
      const [g] = await db
        .select({ groupId: accountGroups.groupId })
        .from(accountGroups)
        .where(and(eq(accountGroups.accountId, loaded.row.accountId), eq(accountGroups.groupId, principalId)))
        .limit(1);
      if (!g) return c.json({ error: 'group not found in this account' }, 404);
    }

    // Agents live in the git config → validate there, store in
    // iam_resource_grants. A typo'd grant would be a silent dead row. (Skills
    // and secrets used to be creatable here too — SECRETS routed to the share
    // model, project_secret_grants — but the resourceType guard above now
    // rejects both before we get here; only 'agent' reaches this point.)
    let config;
    try {
      config = await loadConfigWithFiles(loaded.row);
    } catch (err) {
      return c.json({ error: `project config unavailable: ${err instanceof Error ? err.message : String(err)}` }, 400);
    }
    if (!projectHasResource(config, resourceType, resourceId)) {
      return c.json({ error: `no ${resourceType} '${resourceId}' in this project` }, 400);
    }

    const { grantId } = await upsertResourceGrant({
      accountId: loaded.row.accountId,
      projectId,
      resourceType,
      resourceId,
      principalType,
      principalId,
      grantedBy: loaded.userId,
      expiresAt: expires.value ?? null,
    });
    return c.json({ grant_id: grantId, resource_type: resourceType, resource_id: resourceId, principal_type: principalType, principal_id: principalId }, 201);
  },
);

// DELETE /v1/projects/:projectId/resource-grants/:grantId
projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{projectId}/resource-grants/{grantId}',
    tags: ['access'],
    summary: 'DELETE /:projectId/resource-grants/:grantId',
    ...auth,
    request: { params: z.object({ projectId: z.string(), grantId: z.string() }) },
    responses: { 200: json(z.any(), 'OK'), ...errors(404) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const grantId = c.req.param('grantId');
    // grant_id is a uuid column — a malformed id is a clean 404 (same as missing),
    // not a 22P02 500.
    if (!isUuid(grantId)) return c.json({ error: 'grant not found' }, 404);
    const loaded = await loadProjectForUser(c, projectId, 'manage');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE);

    // The id belongs to an agent/skill grant (iam_resource_grants). Secrets no
    // longer have a resource grant to remove — secret sharing was retired.
    const removed = await deleteResourceGrant(grantId, projectId);
    if (!removed) return c.json({ error: 'grant not found' }, 404);
    return c.json({ ok: true });
  },
);
