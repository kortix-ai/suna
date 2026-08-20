/**
 * Project session lifecycle: create, list, read, sharing, patch and soft delete.
 * Invariant: session_id == sandbox_id == git branch name.
 */

import {
  SESSION_SHARING_OWNER_ONLY_ERROR,
  SHARING_SELF_LOCKOUT_ERROR,
  loadSessionGrants,
  parseSharingIntent,
  resolveShareSubject,
  sessionIntentToVisibility,
  setSessionSharing,
  sharingChangeKeepsEditorAccess,
} from '../../connectors/share';
import { PROJECT_ACTIONS } from '../../iam';
import { assertAgentScope, isProjectSessionPrincipal } from '../../iam/agent-scope';
import { auth, errors, json } from '../../openapi';
import { db } from '../../shared/db';
import { roleAllows } from '../access';
import { createRoute, z } from '@hono/zod-openapi';
import { projectSessions, sessionSandboxes } from '@kortix/db';
import { and, desc, eq, inArray, or } from 'drizzle-orm';
import { loadProjectForUser, loadVisibleSession, lookupEmailsByUserIds, assertProjectCapability, projectCapabilityAllowed, resolveSessionOwnerIdentities } from '../lib/access';
import { AnyObject, OkSchema, SessionCreateAcceptedSchema, SessionCreateInputSchema, SessionSchema, projectsApp } from '../lib/app';
import {
  UUID_V4_REGEX,
  hasOwn,
  normalizeString,
  readBody,
  requestAuditContext,
  serializeSession,
} from '../lib/serializers';
import { resolveAndAuthorizeAgent } from '../lib/agent-access';
import { sendSessionCreateError } from '../lib/sessions';
import { sessionHasMemberConnectorBinding } from '../lib/session-connector-bindings';
import { createSession, deleteSession } from '../session-lifecycle';
import { callerKortixSessionId } from '../lib/caller-session';
import { selectSessionRowsForViewer, type ProjectSessionListScope } from '../lib/session-inventory';

const SERVER_MANAGED_SESSION_METADATA_KEYS = [
  'deletedAt',
  'deletedBy',
  'opencode_model',
  'opencode_model_source',
  'source',
  'trigger_kind',
  'trigger_slug',
  'name',
  'title_source',
] as const;

function serverManagedSessionMetadataKey(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const metadata = value as Record<string, unknown>;
  return SERVER_MANAGED_SESSION_METADATA_KEYS.find((key) => hasOwn(metadata, key)) ?? null;
}

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
        body: { content: { 'application/json': { schema: SessionCreateInputSchema } } },
      },
    responses: {
        201: json(SessionSchema, 'The created session'),
        202: json(SessionCreateAcceptedSchema, 'Create accepted; poll the session'),
        ...errors(400, 403, 404, 409),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const body = await readBody(c);
  const serverManagedMetadataKey = serverManagedSessionMetadataKey(body.metadata);
  if (serverManagedMetadataKey) {
    return c.json(
      { error: `metadata key is server-managed: ${serverManagedMetadataKey}` },
      400,
    );
  }
  const loaded = await loadProjectForUser(c, projectId, 'session');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  // Per-agent gate: starting a session provisions compute. A scoped agent token
  // must hold project.session.start (no-op for human/PAT tokens).
  assertAgentScope(c, PROJECT_ACTIONS.PROJECT_SESSION_START);
  const requestedConnectorBindings = body.connector_bindings;
  const mayManageSystemConnections =
    requestedConnectorBindings &&
    typeof requestedConnectorBindings === 'object' &&
    Object.keys(requestedConnectorBindings).length > 0
      ? await projectCapabilityAllowed(
          c,
          loaded.userId,
          loaded.row.accountId,
          projectId,
          PROJECT_ACTIONS.PROJECT_SESSION_BINDINGS_WRITE,
        )
      : false;
  // Per-RESOURCE scoping: a member/department can only launch agents they're
  // scoped to. No-op when the agent isn't scoped (unscoped = project-wide) and
  // for owner/admins. Mirrors the agent the session core resolves (sessions.ts).
  const launchAgent = normalizeString(body.agent_name ?? body.agentName);
  // Covers BOTH the named agent and — the case that was missing — the unnamed
  // one. No `agent_name` does not mean "no agent": the session core falls back
  // to the manifest's `default_agent`, and that agent must clear the same gate.
  // Skipping it is how a member with no grants still got the fully-privileged
  // default to answer their prompts while the composer showed nothing selected.
  //
  // Runs BEFORE the leaf assert below so its message wins. Both refuse the same
  // requests; only this one can say WHICH agents the caller could pick instead.
  const agentAccess = await resolveAndAuthorizeAgent(c, loaded, projectId, launchAgent);
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
  // When the caller named no agent and this gate could not read one off the
  // request/session/mirror, it picked the first agent the caller may use. For a
  // member that pick has to BIND, because `createSession` resolves the agent
  // again from the manifest and would otherwise start an agent this gate never
  // approved. Managers and owners keep the manifest default untouched.
  if (!launchAgent && agentAccess.memberTier && agentAccess.agentName) {
    body.agent_name = agentAccess.agentName;
  }
  // Bound the client-supplied idempotency key at intake. It's stored in a unique
  // btree (index entry limit ~2704 bytes), so an oversized header would surface
  // as an uncaught 500 (+ Sentry spam) instead of a clean rejection.
  const idempotencyKey = c.req.header('idempotency-key') ?? null;
  if (idempotencyKey !== null && !/^[\w.:+/=-]{1,255}$/.test(idempotencyKey)) {
    return c.json(
      {
        error: 'idempotency-key must be 1–255 characters of [A-Za-z0-9._:+/=-]',
        code: 'INVALID_IDEMPOTENCY_KEY',
      },
      400,
    );
  }
  const result = await createSession({
    source: 'ui',
    project: loaded.row,
    userId: loaded.userId,
    requestingPrincipalType:
      c.get('authType') === 'service_account' ? 'service_account' : 'human',
    body,
    // Origin is derived from the caller's token kind (service_account / pat /
    // 'user' apiKey → backend), never the body — see resolveSessionOrigin. A
    // token operating from INSIDE a session stays 'user'. This uses the
    // session-binding (`sessionId`) or an agent grant.
    authType: c.get('authType') as string | undefined,
    apiKeyType: c.get('apiKeyType') as string | undefined,
    inSession: isProjectSessionPrincipal(c),
    callerSessionId: callerKortixSessionId(c),
    request: requestAuditContext(c),
    idempotencyKey,
    mayManageSystemConnections,
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
// The KaaB contract (backend.mdx, KORTIX_AS_A_BACKEND_GUIDE.md) promises coded
// 400s for the three structured create fields. Schema validation runs before
// the handler, so without this hook zod failures collapse into the generic
// defaultHook envelope and the documented codes never reach HTTP callers.
(result: any, c: any) => {
  if (result.success) return;
  const codes: Record<string, string> = {
    runtime_context: 'INVALID_SESSION_RUNTIME_CONTEXT',
    connector_bindings: 'INVALID_SESSION_CONNECTOR_BINDINGS',
    secrets: 'INVALID_SESSION_SECRETS',
  };
  const issues: Array<{ path?: Array<string | number>; message?: string }> =
    result.error?.issues ?? [];
  const coded = issues.filter((issue) => codes[String(issue.path?.[0] ?? '')]);
  if (coded.length === 0) return;
  return c.json(
    {
      error: coded.map((issue) => issue.message).join('; '),
      code: codes[String(coded[0]!.path![0])],
    },
    400,
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
        query: z.object({
          scope: z.enum(['visible', 'project']).optional(),
        }),
      },
    responses: {
        200: json(z.array(SessionSchema), 'Sessions'),
        ...errors(400, 403, 404),
    },
  }),
  async (c) => {
  const projectId = c.req.param('projectId');
  const scope = (c.req.valid('query').scope ?? 'visible') as ProjectSessionListScope;

  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_SESSION_READ);

  const rows = await db
    .select()
    .from(projectSessions)
    .where(
      and(
        eq(projectSessions.projectId, projectId),
        eq(projectSessions.accountId, loaded.row.accountId),
      ),
    )
    .orderBy(desc(projectSessions.updatedAt));

  const runtimeRows = rows.length
    ? await db
        .select({ sessionId: sessionSandboxes.sessionId, status: sessionSandboxes.status })
        .from(sessionSandboxes)
        .where(
          and(
            eq(sessionSandboxes.projectId, projectId),
            eq(sessionSandboxes.accountId, loaded.row.accountId),
              inArray(
                sessionSandboxes.sessionId,
                rows.map((row) => row.sessionId),
              ),
          ),
        )
    : [];
  const runtimeStatusBySession = new Map(runtimeRows.map((row) => [row.sessionId, row.status]));

  const subject = await resolveShareSubject(loaded.userId);
  const canManageProject =
    roleAllows(loaded.effectiveRole, 'manage') ||
    (await projectCapabilityAllowed(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      'project.members.manage',
    ));
  const grantsBySession = await loadSessionGrants(
    rows.filter((row) => row.visibility === 'restricted').map((row) => row.sessionId),
  );
  const selected = selectSessionRowsForViewer({
    rows,
    scope,
    canManageProject,
    subject,
    grantsBySession,
    runtimeStatusBySession,
    callerSessionId: callerKortixSessionId(c),
    boundCredentialSessionId: callerKortixSessionId(c),
  });
  if (!selected.authorized) {
    return c.json({ error: 'Project manager access is required to list every session' }, 403);
  }

  const ownerIds = selected.items
    .map((item) => item.row.createdBy)
    .filter((ownerId): ownerId is string => Boolean(ownerId));
  const ownerIdentities = await resolveSessionOwnerIdentities(ownerIds, loaded.row.accountId);

  return c.json(
    selected.items.map((item) => {
      const row = item.row;
      const owner = row.createdBy ? ownerIdentities.get(row.createdBy) : null;
      return serializeSession(row, {
        grants: grantsBySession.get(row.sessionId) ?? [],
        viewerId: loaded.userId,
        canManageProject,
        // Only a RESOLVED service account counts as machine-owned. 'unknown'
        // (a stale principal) keeps the session owner-only — fail closed.
        ownerIsMachine: !row.createdBy || owner?.type === 'service_account',
        ownerEmail: owner?.email ?? null,
        ownerName: owner?.name ?? null,
        ownerType: owner?.type ?? (row.createdBy ? 'unknown' : null),
        canAccess: item.canAccess,
        runtimeStatus: item.runtimeStatus,
        deletedAt: item.deletedAt,
        deletedBy: item.deletedBy,
      });
    }),
  );
},
);

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

  const visible = await loadVisibleSession(loaded, sessionId, c.get('sessionId') ?? null, callerKortixSessionId(c));
  if (!visible) return c.json({ error: 'Not found' }, 404);
  // A soft-deleted session is gone for a read-by-id, exactly as it is for the
  // default list. `deleteSession` only stamps `metadata.deletedAt`
  // (session-lifecycle/actions.ts), and this loader never looked at it, so a
  // deleted session stayed readable by id — and `serializeSession` reported it
  // as `deleted_at: null` here, because only the list passes that context. Use
  // the same predicate the list uses (session-inventory.ts: a STRING deletedAt
  // hides the row). `scope=project` on the LIST deliberately keeps tombstones
  // for managers; that path is untouched.
  const deletedAt = (visible.row.metadata ?? {}) as Record<string, unknown>;
  if (typeof deletedAt.deletedAt === 'string') return c.json({ error: 'Not found' }, 404);
  const ownerEmail = visible.row.createdBy && !visible.isOwner
    ? (await lookupEmailsByUserIds([visible.row.createdBy])).get(visible.row.createdBy) ?? null
    : null;
  return c.json(serializeSession(visible.row, {
    grants: visible.grants,
    viewerId: loaded.userId,
    canManageProject: visible.canManageProject,
    ownerIsMachine: visible.ownerIsMachine,
    ownerEmail,
  }));
},
);

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
        ...errors(400, 403, 404, 409),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const sessionId = c.req.param('sessionId');
  if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

  const body = await readBody(c);
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const visible = await loadVisibleSession(loaded, sessionId, c.get('sessionId') ?? null, callerKortixSessionId(c));
  if (!visible) return c.json({ error: 'Not found' }, 404);
  // Owner-governed, NOT manager-tier — see mayManageSessionSharing. A manager
  // cannot read another human's private session, so letting them rewrite its
  // visibility would hand them the content the read gate just denied.
  if (!visible.canManageSharing) {
      return c.json({ error: SESSION_SHARING_OWNER_ONLY_ERROR }, 403);
  }

  const intent = parseSharingIntent(body, loaded.userId);
    if (!intent)
      return c.json({ error: 'invalid sharing — mode must be project|private|members' }, 400);

  // Reachable only for a machine-owned session a manager is editing: `private`
  // means "the OWNER only", so saving it here would lock the editor out of a
  // session they can no longer re-open to undo it.
  const next = sessionIntentToVisibility(intent);
  if (
    !sharingChangeKeepsEditorAccess({
      isOwner: visible.isOwner,
      visibility: next.visibility,
      grants: next.grants,
      subject: visible.subject,
    })
  ) {
    return c.json({ error: SHARING_SELF_LOCKOUT_ERROR }, 400);
  }

  if (
    intent.mode !== 'private' &&
    (await sessionHasMemberConnectorBinding({
      accountId: loaded.row.accountId,
      projectId,
      sessionId,
    }))
  ) {
    return c.json(
      {
        error: 'Sessions using a personal connection must remain private',
        code: 'PERSONAL_CONNECTOR_CONNECTION_REQUIRES_PRIVATE_SESSION',
      },
      409,
    );
  }

  await setSessionSharing(sessionId, intent);

  const fresh = await loadVisibleSession(loaded, sessionId, c.get('sessionId') ?? null, callerKortixSessionId(c));
    return c.json(
      fresh
        ? serializeSession(fresh.row, {
    grants: fresh.grants,
    viewerId: loaded.userId,
    canManageProject: fresh.canManageProject,
    ownerIsMachine: fresh.ownerIsMachine,
          })
        : { ok: true },
    );
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
    const opencodeManagedField = ['opencode_session_id', 'opencodeSessionId'].find((f) =>
      hasOwn(body, f),
    );
  if (opencodeManagedField) {
    return c.json({ error: `field is server-managed: ${opencodeManagedField}` }, 400);
  }

  const allowedFields = ['name', 'metadata'];
  const unknownField = Object.keys(body).find((field) => !allowedFields.includes(field));
  if (unknownField) {
    return c.json({ error: `field is not user-editable: ${unknownField}` }, 400);
  }

  // metadata.deletedAt / deletedBy are SERVER-MANAGED soft-delete markers.
  // deleteSession() is the only legitimate writer; they are consumed by
  // isSessionVisibleTo (session-inventory.ts — hides the session from every member's
  // list), the continue-session guard (session-lifecycle/engine.ts:236 —
  // returns 'no-session' so queued Slack/trigger follow-ups 404), and the
  // sandbox reaper (sandbox-reaper.ts:477 — tombstones the live box).
  // Letting a client forge either via PATCH lets any project member hide
  // another member's session, block its follow-ups, and trip the reaper.
  // See SSR-7 (weekly pentest run #4).
  // opencode_model is create-only by contract and changed only via
  // PUT /sessions/{id}/model, which validates it against the account. Planting
  // it through metadata skipped that check entirely, so a retired or
  // account-forbidden model could be stored and booted by the next cold provision.
  // source / trigger_kind / trigger_slug identify sessions created by the
  // durable trigger path. Manager visibility trusts all three fields, so only
  // the server can write them.
  // name / title_source are owned by the title generator (the SINGLE writer of
  // metadata.name — see projects/session-title-generate.ts). A client that plants
  // a non-placeholder name pre-empts titling permanently, since `needsTitle` and
  // the CAS both then refuse; renaming is `body.name` → metadata.custom_name,
  // which is the supported, non-destructive override.
  const forgedKey = serverManagedSessionMetadataKey(body.metadata);
  if (forgedKey) {
    return c.json({ error: `metadata key is server-managed: ${forgedKey}` }, 400);
  }
  const metadata =
    body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
      ? (body.metadata as Record<string, unknown>)
      : null;

  const visible = await loadVisibleSession(loaded, sessionId, c.get('sessionId') ?? null, callerKortixSessionId(c));
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
      .where(
        and(
      eq(projectSessions.sessionId, sessionId),
      eq(projectSessions.projectId, projectId),
      eq(projectSessions.accountId, loaded.row.accountId),
        ),
      )
    .returning();

  if (!row) return c.json({ error: 'Not found' }, 404);
    return c.json(
      serializeSession(row, {
    grants: visible.grants,
    viewerId: loaded.userId,
    canManageProject: visible.canManageProject,
    ownerIsMachine: visible.ownerIsMachine,
      }),
    );
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
  const visible = await loadVisibleSession(loaded, sessionId, c.get('sessionId') ?? null, callerKortixSessionId(c));
  if (!visible) return c.json({ error: 'Not found' }, 404);
  if (!visible.canManageLifecycle) {
      return c.json(
        { error: 'Only the session owner or a project manager can stop this session' },
        403,
      );
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
