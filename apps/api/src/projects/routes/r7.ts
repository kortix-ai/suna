import { pauseComputeSession } from '../../billing/services/compute-metering';
import { config, type SandboxProviderName } from '../../config';
import { isSessionVisibleTo, loadSessionGrants, parseSharingIntent, resolveShareSubject, setSessionSharing } from '../../executor/share';
import { PROJECT_ACTIONS, assertAuthorized } from '../../iam';
import { auth, errors, json } from '../../openapi';
import { getProvider } from '../../platform/providers';
import { db } from '../../shared/db';
import { roleAllows } from '../access';
import { ensureOpencodeSessionPin } from '../opencode-mapping';
import { createRoute, z } from '@hono/zod-openapi';
import { accountGroupMembers, accountGroups, accountMembers, projectGroupGrants, projectSessions, sessionSandboxes } from '@kortix/db';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { loadProjectForUser, loadVisibleSession, lookupEmailsByUserIds, parseExpiresAtBody } from '../lib/access';
import { AnyObject, GroupGrantSchema, SessionSchema, projectsApp } from '../lib/app';
import { UUID_V4_REGEX, hasOwn, isProjectRole, normalizeString, readBody, requestAuditContext, serializeSession, serializeSessionSandboxConfig } from '../lib/serializers';
import { createProjectSession, sendSessionCreateError } from '../lib/sessions';
import { kickProvisionOnOpen, resumeStoppedSandbox, syncOpencodeSessionsHandler } from './shared';

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
  await assertAuthorized(
    loaded.userId,
    loaded.row.accountId,
    PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE,
    { type: 'project', id: projectId },
  );

  const body = await readBody(c);
  const groupId = normalizeString(body.group_id ?? body.groupId);
  const role = body.role;
  if (!groupId) return c.json({ error: 'group_id is required' }, 400);
  if (!isProjectRole(role)) {
    return c.json({ error: 'role must be manager, editor, or viewer' }, 400);
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
  await assertAuthorized(
    loaded.userId,
    loaded.row.accountId,
    PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE,
    { type: 'project', id: projectId },
  );

  const body = await readBody(c);
  if (!isProjectRole(body.role)) {
    return c.json({ error: 'role must be manager, editor, or viewer' }, 400);
  }
  const expires = parseExpiresAtBody(body.expires_at);
  if (!expires.ok) return c.json({ error: expires.error }, 400);

  const result = await db
    .update(projectGroupGrants)
    .set({
      role: body.role,
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
  await assertAuthorized(
    loaded.userId,
    loaded.row.accountId,
    PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE,
    { type: 'project', id: projectId },
  );

  await db
    .delete(projectGroupGrants)
    .where(
      and(
        eq(projectGroupGrants.projectId, projectId),
        eq(projectGroupGrants.groupId, groupId),
      ),
    );

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
        ...errors(404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const body = await readBody(c);
  const loaded = await loadProjectForUser(c, projectId, 'write');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  const result = await createProjectSession({
    project: loaded.row,
    userId: loaded.userId,
    body,
    request: requestAuditContext(c),
  });
  if (result.error) return sendSessionCreateError(c, result.error);
  for (const [key, value] of Object.entries(result.headers ?? {})) {
    c.header(key, value);
  }
  return c.json(
    serializeSession(result.row!, {
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
  async (c: any) => {
  const projectId = c.req.param('projectId');

  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

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
  const visible = listableRows.filter((r) =>
    isSessionVisibleTo(
      r.visibility as 'private' | 'project' | 'restricted',
      r.createdBy,
      grantsBySession.get(r.sessionId) ?? [],
      subject,
    ),
  );
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
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const sessionId = c.req.param('sessionId');
  if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const visible = await loadVisibleSession(loaded, sessionId);
  if (!visible) return c.json({ error: 'Not found' }, 404);

  const ownerEmail = visible.row.createdBy && !visible.isOwner
    ? (await lookupEmailsByUserIds([visible.row.createdBy])).get(visible.row.createdBy) ?? null
    : null;
  return c.json(serializeSession(visible.row, {
    grants: visible.grants,
    viewerId: loaded.userId,
    canManageProject: visible.canManageProject,
    ownerEmail,
  }));
},
);

// POST /v1/projects/:projectId/sessions/:sessionId/ensure-opencode
// Backend-owned mapping: resolve the sandbox's canonical OpenCode root id and
// persist it to project_sessions.opencode_session_id. This is the sole
// authoritative writer of the pin. Idempotent — repeated calls are no-ops once
// the pin matches the live root; heals a stale/missing pin; creates a root if
// the sandbox has none.

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/sessions/{sessionId}/ensure-opencode',
    tags: ['sessions'],
    summary: 'POST /:projectId/sessions/:sessionId/ensure-opencode',
    ...auth,
      request: {
        params: z.object({ projectId: z.string(), sessionId: z.string() }),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(400, 404, 409),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const sessionId = c.req.param('sessionId');
  if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

  const loaded = await loadProjectForUser(c, projectId, 'write');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  const visible = await loadVisibleSession(loaded, sessionId);
  if (!visible) return c.json({ error: 'Not found' }, 404);

  const [sandbox] = await db
    .select({ externalId: sessionSandboxes.externalId })
    .from(sessionSandboxes)
    .where(and(
      eq(sessionSandboxes.sessionId, sessionId),
      eq(sessionSandboxes.projectId, projectId),
      eq(sessionSandboxes.accountId, loaded.row.accountId),
    ))
    .limit(1);
  if (!sandbox?.externalId) return c.json({ error: 'sandbox not provisioned' }, 409);

  const result = await ensureOpencodeSessionPin({
    projectId,
    sessionId,
    accountId: loaded.row.accountId,
    externalId: sandbox.externalId,
    userId: loaded.userId,
    currentPin: visible.row.opencodeSessionId ?? null,
  });

  // Re-read so the serialized row reflects the (possibly) updated pin.
  const [row] = await db
    .select()
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);

  return c.json({
    ...serializeSession(row ?? visible.row, {
      grants: visible.grants,
      viewerId: loaded.userId,
      canManageProject: visible.canManageProject,
    }),
    ensure: { reason: result.reason, changed: result.changed, pin: result.pin },
  });
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
        200: json(z.any(), 'OK'),
        ...errors(400, 404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const sessionId = c.req.param('sessionId');
  if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

  const body = await readBody(c);
  const loaded = await loadProjectForUser(c, projectId, 'write');
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
  // metadata.custom_name — a separate key from metadata.name (the auto title
  // mirrored from opencode by /sync-opencode-sessions) so a rename is never
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

// POST /v1/projects/sync-opencode-sessions
// Mirrors session data from the sandbox-local opencode DB into our cloud DB.
// The project_sessions row remains the branch+sandbox root;
// metadata.opencode_sessions stores the local OpenCode root/sub-session graph
// for sidebar/list rendering when the sandbox is not the active runtime.

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/sync-opencode-sessions',
    tags: ['sessions'],
    summary: 'POST /sync-opencode-sessions',
    ...auth,
    responses: {
        200: json(z.any(), 'OK'),
    },
  }),
  syncOpencodeSessionsHandler as any,
);

// GET /v1/projects/:projectId/sessions/:sessionId/sandbox
// Returns the session's sandbox runtime row from `kortix.session_sandboxes`.
// Decoupled from the legacy /instances sandbox table: no billing fields, no
// team-membership coupling. Returns 404 while the row is being inserted —
// the frontend polls.
// Provision a sandbox for a dormant session (e.g. a migrated legacy session) on
// first open. Fire-and-forget; flips the session to 'provisioning' first so the
// status guard at the call sites prevents re-kicking on every poll.

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/sessions/{sessionId}/sandbox',
    tags: ['sessions'],
    summary: 'GET /:projectId/sessions/:sessionId/sandbox',
    ...auth,
      request: {
        params: z.object({ projectId: z.string(), sessionId: z.string() }),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(400, 404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const sessionId = c.req.param('sessionId');
  if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  // Only members who can see the session may reach its sandbox.
  const sandboxVisible = await loadVisibleSession(loaded, sessionId);
  if (!sandboxVisible) return c.json({ error: 'Not found' }, 404);

  let [row] = await db
    .select()
    .from(sessionSandboxes)
    .where(and(
      eq(sessionSandboxes.sessionId, sessionId),
      eq(sessionSandboxes.projectId, projectId),
      eq(sessionSandboxes.accountId, loaded.row.accountId),
    ))
    .limit(1);

  // Hibernated sandbox (explicit Stop / idle maintenance set status='stopped'
  // but KEPT the VM + disk via provider.stop). Resume it in place rather than
  // deleting + cold-reprovisioning a box whose workspace is still intact — the
  // whole point of hibernate-over-destroy. resumeStoppedSandbox flips the row
  // back to 'active' and kicks the provider start in the background; we re-read
  // so the response carries the fresh status and the frontend's health poll
  // takes over (identical to the idle-wake path). Concurrent polls that lose
  // the transition just fall through and read the now-'active' row.
  if (row && row.status === 'stopped' && row.externalId
      && (config.ALLOWED_SANDBOX_PROVIDERS as readonly string[]).includes(row.provider)) {
    await resumeStoppedSandbox({
      sandboxId: row.sandboxId,
      sessionId: row.sessionId,
      accountId: row.accountId,
      provider: row.provider,
      externalId: row.externalId,
    });
    const [resumed] = await db
      .select()
      .from(sessionSandboxes)
      .where(eq(sessionSandboxes.sandboxId, row.sandboxId))
      .limit(1);
    if (resumed) row = resumed;
  }

  // (Re)provision on open when there's no usable sandbox: a dormant migrated
  // session (no row), or a truly dead one (error / no externalId — a hibernated
  // box would have been resumed above, not deleted). The UI polls this endpoint,
  // so it's the natural trigger. The project_session 'provisioning' flag (set by
  // kickProvisionOnOpen) guards against re-kicking on subsequent 404 polls.
  const usable = row && (row.status === 'provisioning' || row.status === 'active');
  if (!usable) {
    if (['failed', 'stopped', 'completed'].includes(sandboxVisible.row.status)) {
      return c.json({
        error: `Session is ${sandboxVisible.row.status}`,
        session_status: sandboxVisible.row.status,
        retriable: false,
      }, 409);
    }
    if (sandboxVisible.row.status !== 'provisioning') {
      if (row) {
        await db.delete(sessionSandboxes).where(eq(sessionSandboxes.sandboxId, sessionId)).catch(() => {});
      }
      await kickProvisionOnOpen(loaded, sandboxVisible.row, projectId, sessionId);
    }
    return c.json({ error: 'Not found' }, 404);
  }

  return c.json({
    sandbox_id: row.sandboxId,
    session_id: row.sessionId,
    project_id: row.projectId,
    account_id: row.accountId,
    provider: row.provider,
    external_id: row.externalId,
    base_url: row.baseUrl,
    status: row.status,
    config: serializeSessionSandboxConfig(row.config),
    metadata: row.metadata ?? {},
    last_used_at: row.lastUsedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  });
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
        200: json(z.any(), 'OK'),
        ...errors(400, 403, 404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const sessionId = c.req.param('sessionId');
  if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

  const loaded = await loadProjectForUser(c, projectId, 'write');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  // Stopping a session is reserved for its owner or a project manager.
  const visible = await loadVisibleSession(loaded, sessionId);
  if (!visible) return c.json({ error: 'Not found' }, 404);
  if (!visible.canManageSharing) {
    return c.json({ error: 'Only the session owner or a project manager can stop this session' }, 403);
  }

  const [sandbox] = await db
    .select()
    .from(sessionSandboxes)
    .where(and(
      eq(sessionSandboxes.sessionId, sessionId),
      eq(sessionSandboxes.projectId, projectId),
      eq(sessionSandboxes.accountId, loaded.row.accountId),
    ))
    .limit(1);

  const deletedAt = new Date();
  const [row] = await db
    .update(projectSessions)
    .set({
      status: 'stopped',
      metadata: {
        ...(visible.row.metadata ?? {}),
        deletedAt: deletedAt.toISOString(),
        deletedBy: loaded.userId,
      },
      updatedAt: deletedAt,
    })
    .where(and(
      eq(projectSessions.sessionId, sessionId),
      eq(projectSessions.projectId, projectId),
      eq(projectSessions.accountId, loaded.row.accountId),
    ))
    .returning();

  if (!row) return c.json({ error: 'Not found' }, 404);

  if (sandbox) {
    await db
      .update(sessionSandboxes)
      .set({
        // 'archived' — NOT 'stopped'. Explicit session deletion is the one case
        // where we remove the provider box (below), so the disk is gone. Marking
        // it 'archived' (vs the 'stopped' = hibernated-and-resumable state used
        // by idle/maintenance) tells GET …/sandbox NOT to attempt a resume of a
        // box that no longer exists; reopening a deleted session cold-reprovisions
        // fresh from the preserved git branch instead.
        status: 'archived',
        metadata: {
          ...(sandbox.metadata ?? {}),
          stoppedAt: deletedAt.toISOString(),
          initStatus: sandbox.status === 'active' ? 'ready' : 'failed',
          ...(sandbox.status === 'active'
            ? {}
            : { lastInitError: 'Session was stopped before sandbox initialization completed' }),
        },
        updatedAt: new Date(),
      })
      .where(eq(sessionSandboxes.sandboxId, sandbox.sandboxId))
      .catch((err) => {
        console.warn(`[projects] failed to mark session sandbox archived for ${sessionId}:`, err);
      });

    if (sandbox.externalId && (config.ALLOWED_SANDBOX_PROVIDERS as readonly string[]).includes(sandbox.provider)) {
      const provider = getProvider(sandbox.provider as SandboxProviderName);
      // Explicit user session deletion is the ONLY place we remove the provider
      // box. Everywhere else (idle auto-stop, maintenance, restart) hibernates
      // instead, because a stopped Daytona box auto-archives to cheap cold
      // storage and can be resumed in place. Here the user has chosen to delete
      // the session, so we free the compute outright — the work is safe on the
      // git branch, which we deliberately preserve.
      void provider.remove(sandbox.externalId).catch((err) => {
        console.warn(`[projects] failed to remove provider sandbox ${sandbox.externalId} for deleted session ${sessionId}:`, err);
      });
    }
  }

  void pauseComputeSession(sessionId).catch((err) =>
    console.warn(`[projects] compute pause failed for ${sessionId}:`, err),
  );

  return c.json({ ok: true });
},
);

// POST /v1/projects/:projectId/sessions/:sessionId/wake
// Wake a sandbox that the provider auto-stopped while idle. The DB row still
// reads `active` (nothing updates it when Daytona auto-stops after ~15min), so
// opening such a session would otherwise hit a dead container and spin on the
// health poll. The frontend fires this on open: a running sandbox is a cheap
// status no-op; a stopped one gets started in the background while the health
// poll picks up readiness — so the request returns instantly either way.
