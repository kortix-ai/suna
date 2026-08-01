import { isCallLive, readTurns } from '../../channels/voice/runtime';
import { SessionScopeInputSchema, SessionScopeSchema } from '@kortix/api-contract';
import { recordSessionToolApproval } from '../../executor/db-deps';
import { approvalResolvedAuditEvent } from '../../executor/execution-audit';
import { loadSessionGrants, parseSharingIntent, resolveShareSubject, setSessionSharing } from '../../executor/share';
import {
  PROJECT_ACTIONS,
  deleteResourceGrant,
  isCreatableResourceType,
  listResourceGrants,
  upsertResourceGrant,
} from '../../iam';
import {
  assertAgentScope,
  isProjectSessionPrincipal,
} from '../../iam/agent-scope';
import { approvalPageUrl } from '../../setup-links/token';
import { invalidateIamCacheForGroup } from '../../iam/cache-invalidation';
import { normalizeProjectRole } from '../../iam/role-perms';
import { projectHasResource, projectResourcesFromConfig, loadConfigWithFiles } from '../lib/project-resources';
import { auth, errors, json } from '../../openapi';
import { DEFAULT_SANDBOX_SLUG } from '../../snapshots/builder';
import { db } from '../../shared/db';
import { inferAuditSource, recordAuditEvent } from '../../shared/audit';
import { roleAllows } from '../access';
import { createRoute, z } from '@hono/zod-openapi';
import { accountGroupMembers, accountGroups, accountMembers, executorConnectors, executorExecutions, projectGroupGrants, projectSessions, sessionSandboxes,
  projectSessionConnectorBindings,
  serviceAccounts,
} from '@kortix/db';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { mayResolveApproval, maySeeSessionApprovals } from '../lib/approval-authority';
import { getCachedAccountTier } from '../../billing/services/entitlements';
import { tierGrantsAllModels } from '../../billing/services/tiers';
import { config } from '../../config';
import {
  canChangeSessionModel,
  mayChangeSessionModel,
  modelChangeNeedsLivePush,
  modelChangeResult,
  validateModelChangeShape,
} from '../lib/session-model-change';
import { pushSessionModelToSandbox } from '../lib/sandbox-env-sync';
import { isModelServableForAccount } from '../../llm-gateway/resolution/default-model';
import { toOpencodeModelRef } from '../../llm-gateway/resolution/effective';
import { loadProjectForUser, loadVisibleSession, lookupEmailsByUserIds, parseExpiresAtBody, assertProjectCapability, isUuid, projectCapabilityAllowed, resolveSessionOwnerIdentities } from '../lib/access';
import { AnyObject, ClaimWarmProjectSessionInputSchema, GroupGrantSchema, OkSchema, SessionCreateAcceptedSchema, SessionCreateInputSchema, SessionSchema, WarmProjectSessionResultSchema, projectsApp } from '../lib/app';
import { UUID_V4_REGEX, hasOwn, normalizeString, readBody, requestAuditContext, serializeSession } from '../lib/serializers';
import { createProjectSession, sendSessionCreateError, type SessionCreateError } from '../lib/sessions';
import {
  RequiredConnectorProfileUnavailableError,
  resolveEffectiveSessionConnectorBindings,
  sessionHasMemberConnectorBinding,
  sessionConnectorBindingsRequirePrivateVisibility,
  validateSessionConnectorBindings,
} from '../lib/session-connector-bindings';
import { buildSessionTranscriptDigest } from '../lib/session-transcript';
import {
  claimAvailableWarmProjectSession,
  discardAvailableWarmProjectSession,
  findAvailableWarmProjectSession,
  withWarmProjectSessionLock,
} from '../lib/warm-session-store';
import { refreshWarmSessionWorkspace } from '../lib/warm-session-workspace';
import {
  createWarmProjectSessionCoordinator,
  WarmProjectSessionError,
} from '../lib/warm-sessions';
import {
  createSession,
  deleteSession,
  drainSessionLifecycleQueue,
  enqueueContinueSessionCommand,
} from '../session-lifecycle';
import { requireEntitlement } from '../../accounts/iam/helpers';
import { accountHasEntitlement } from '../../billing/services/entitlements';
import { callerKortixSessionId } from '../lib/caller-session';
import {
  canonicalConnectorAlias,
  publicConnectorAlias,
} from '../../shared/connector-alias';
import { DEFAULT_AGENT_SENTINEL } from '../agents';
import { resolveSessionAgentGrant } from '../lib/secret-grant';
import { rescopeSessionBindings, rescopeSessionSecrets } from '../lib/session-rescope';
import {
  listResolvedProjectSecrets,
  secretKeyCollisionInAllowlist,
} from '../secrets';
import { selectSessionRowsForViewer, type ProjectSessionListScope } from '../lib/session-inventory';
import { missingWarmSessionAuthorizations } from '../lib/warm-session-authorizations';

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
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_SESSION_READ);

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

class WarmSessionCreateFailure extends Error {
  constructor(readonly detail: SessionCreateError) {
    super(
      typeof detail.body.error === 'string'
        ? detail.body.error
        : 'Warm session creation failed',
    );
    this.name = 'WarmSessionCreateFailure';
  }
}

function resolvedWarmSessionConfiguration(project: {
  defaultBranch: string;
  metadata: Record<string, unknown> | null;
}) {
  const metadata = project.metadata ?? {};
  return {
    baseRef: project.defaultBranch,
    agentName: normalizeString(metadata.default_agent) ?? 'default',
    sandboxSlug:
      normalizeString(metadata.default_sandbox_slug) ?? DEFAULT_SANDBOX_SLUG,
  };
}

function connectorAuthorizationRequiredError(
  connectorProfiles: Awaited<ReturnType<typeof missingWarmSessionAuthorizations>>,
): SessionCreateError {
  return {
    status: 409,
    body: {
      code: 'CONNECTOR_AUTHORIZATION_REQUIRED',
      message: 'Connect the required connector profiles before starting this session.',
      connector_profiles: connectorProfiles,
    },
  };
}

function unavailableRequiredConnectorError(
  error: RequiredConnectorProfileUnavailableError,
): SessionCreateError {
  return {
    status: 409,
    body: {
      error: error.message,
      code: error.code,
      // The docs tell clients to read `connectors` and never to parse `error`.
      // This site emitted only the prose, so a caller obeying that instruction
      // got `undefined` here while the create path worked. The shape has to be
      // the same wherever the code appears, or the contract is a lie on one path.
      connectors: error.aliases.map(publicConnectorAlias),
    },
  };
}

// POST /v1/projects/:projectId/sessions/warm

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/sessions/warm',
    tags: ['sessions'],
    summary: 'Create or reuse the current user warm project session',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: z.object({}).strict() } } },
    },
    responses: {
      200: json(WarmProjectSessionResultSchema, 'The available warm session'),
      ...errors(400, 402, 403, 404, 409, 429, 500, 503),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'session');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    assertAgentScope(c, PROJECT_ACTIONS.PROJECT_SESSION_START);

    const scope = {
      accountId: loaded.row.accountId,
      projectId,
      userId: loaded.userId,
    };
    const configuration = resolvedWarmSessionConfiguration(loaded.row);
    const coordinator = createWarmProjectSessionCoordinator({
      exclusive: (operation) => withWarmProjectSessionLock(scope, operation),
      findAvailable: () => findAvailableWarmProjectSession(scope),
      discard: (sessionId, metadata) =>
        discardAvailableWarmProjectSession(scope, sessionId, metadata),
      claim: (sessionId, metadata) =>
        claimAvailableWarmProjectSession(scope, sessionId, metadata),
      create: async (metadata) => {
        const result = await createProjectSession({
          project: loaded.row,
          userId: loaded.userId,
          requestingPrincipalType:
            c.get('authType') === 'service_account' ? 'service_account' : 'human',
          body: {
            base_ref: configuration.baseRef,
            agent_name: configuration.agentName,
            sandbox_slug: configuration.sandboxSlug,
          },
          metadata: { source: 'ui', ...metadata },
          authType: c.get('authType') as string | undefined,
          apiKeyType: c.get('apiKeyType') as string | undefined,
          inSession: isProjectSessionPrincipal(c),
          request: requestAuditContext(c),
        });
        if (result.error) throw new WarmSessionCreateFailure(result.error);
        if (!result.row) {
          throw new WarmSessionCreateFailure({
            status: 500,
            body: { error: 'Warm session creation returned no row', retry: true },
          });
        }
        return result.row;
      },
    });

    try {
      const ensured = await coordinator.ensure(configuration);
      if (ensured.reused) {
        const missing = await missingWarmSessionAuthorizations(loaded.row, ensured.session);
        if (missing.length > 0) {
          const currentMarker =
            ensured.session.metadata?.warm_session &&
            typeof ensured.session.metadata.warm_session === 'object' &&
            !Array.isArray(ensured.session.metadata.warm_session)
              ? ensured.session.metadata.warm_session
              : {};
          await discardAvailableWarmProjectSession(scope, ensured.session.sessionId, {
            ...(ensured.session.metadata ?? {}),
            warm_session: {
              ...currentMarker,
              state: 'discarded',
              discarded_at: new Date().toISOString(),
              discard_reason: 'connector_authorization_invalid',
            },
          });
          return sendSessionCreateError(c, connectorAuthorizationRequiredError(missing));
        }
      }
      const workspaceRefresh = ensured.reused
        ? await refreshWarmSessionWorkspace(
            loaded.row,
            ensured.session.sessionId,
          )
        : { status: 'skipped' as const };
      return c.json(
        {
          session: serializeSession(ensured.session, {
            viewerId: loaded.userId,
            canManageProject: roleAllows(loaded.effectiveRole, 'manage'),
          }),
          reused: ensured.reused,
          workspace_refresh: workspaceRefresh,
        },
        200,
      );
    } catch (error) {
      if (error instanceof RequiredConnectorProfileUnavailableError) {
        return sendSessionCreateError(c, unavailableRequiredConnectorError(error));
      }
      if (error instanceof WarmSessionCreateFailure) {
        return sendSessionCreateError(c, error.detail);
      }
      throw error;
    }
  },
);

// POST /v1/projects/:projectId/sessions/warm/claim

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/sessions/warm/claim',
    tags: ['sessions'],
    summary: 'Claim the current user warm project session',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: {
        content: {
          'application/json': { schema: ClaimWarmProjectSessionInputSchema },
        },
      },
    },
    responses: {
      200: json(SessionSchema, 'The claimed session'),
      ...errors(400, 403, 404, 409),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const body = await readBody(c);
    const sessionId = normalizeString(body.session_id);
    if (!sessionId || !UUID_V4_REGEX.test(sessionId)) {
      return c.json({ error: 'Invalid session id', code: 'INVALID_SESSION_ID' }, 400);
    }

    const loaded = await loadProjectForUser(c, projectId, 'session');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    assertAgentScope(c, PROJECT_ACTIONS.PROJECT_SESSION_START);

    const scope = {
      accountId: loaded.row.accountId,
      projectId,
      userId: loaded.userId,
    };
    const coordinator = createWarmProjectSessionCoordinator({
      findAvailable: () => findAvailableWarmProjectSession(scope),
      discard: (candidateSessionId, metadata) =>
        discardAvailableWarmProjectSession(scope, candidateSessionId, metadata),
      claim: (candidateSessionId, metadata) =>
        claimAvailableWarmProjectSession(scope, candidateSessionId, metadata),
      create: async () => {
        throw new Error('Claim cannot create a warm session');
      },
    });

    try {
      const candidate = await findAvailableWarmProjectSession(scope);
      if (candidate?.sessionId === sessionId) {
        const missing = await missingWarmSessionAuthorizations(loaded.row, candidate);
        if (missing.length > 0) {
          return sendSessionCreateError(c, connectorAuthorizationRequiredError(missing));
        }
      }

      const claimed = await coordinator.claim({
        sessionId,
        agentName: normalizeString(body.agent_name) ?? undefined,
        sandboxSlug: normalizeString(body.sandbox_slug) ?? undefined,
      });
      return c.json(
        serializeSession(claimed, {
          viewerId: loaded.userId,
          canManageProject: roleAllows(loaded.effectiveRole, 'manage'),
        }),
        200,
      );
    } catch (error) {
      if (error instanceof RequiredConnectorProfileUnavailableError) {
        return sendSessionCreateError(c, unavailableRequiredConnectorError(error));
      }
      if (error instanceof WarmProjectSessionError) {
        return c.json({ error: error.message, code: error.code }, error.status as 409);
      }
      throw error;
    }
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
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  // assertProjectCapability (not bare assertAuthorized) so the acting token is
  // threaded and the agent-grant fold fires: an agent-session token must also
  // hold project.members.manage to mutate group grants, not just its user.
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE);
  // Entitlement mirror of accounts/iam/groups.ts so grants can't be minted
  // through the project-scoped path when the account-scoped one is gated.
  // Dormant since 2026-07-08: `rbac` is granted on every tier (groups + roles
  // are core collaboration, not an upsell) — it only bites again if the
  // packaging in tiers.ts changes.
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
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  // assertProjectCapability (not bare assertAuthorized) so the acting token is
  // threaded and the agent-grant fold fires: an agent-session token must also
  // hold project.members.manage to mutate group grants, not just its user.
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE);
  // Same dormant entitlement mirror as the POST above (rbac is on every
  // tier). DELETE below carries no gate at all: revoking access is never
  // paywalled, so an account can always detach grants it can't manage.
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
  const loaded = await loadProjectForUser(c, projectId, 'read');
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
  const loaded = await loadProjectForUser(c, projectId, 'session');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  // Per-agent gate: starting a session provisions compute. A scoped agent token
  // must hold project.session.start (no-op for human/PAT tokens).
  assertAgentScope(c, PROJECT_ACTIONS.PROJECT_SESSION_START);
  const requestedConnectorBindings = body.connector_bindings;
  const mayManageSystemConnectorProfiles =
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
    request: requestAuditContext(c),
    idempotencyKey,
    mayManageSystemConnectorProfiles,
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
            inArray(sessionSandboxes.sessionId, rows.map((row) => row.sessionId)),
          ),
        )
    : [];
  const runtimeStatusBySession = new Map(runtimeRows.map((row) => [row.sessionId, row.status]));

  const subject = await resolveShareSubject(loaded.userId);
  const canManageProject = roleAllows(loaded.effectiveRole, 'manage');
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

  const visible = await loadVisibleSession(loaded, sessionId, c.get('sessionId') ?? null);
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

  const visible = await loadVisibleSession(loaded, sessionId, c.get('sessionId') ?? null);
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
    const visible = await loadVisibleSession(loaded, sessionId, c.get('sessionId') ?? null);
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

    // Connector slugs in one batched lookup — the UI needs `<slug>.<action>`
    // to offer a "always run this" project-policy shortcut on a pending row.
    const connectorIds = [...new Set(rows.map((r) => r.connectorId).filter((v): v is string => !!v))];
    const slugByConnector = new Map<string, string>();
    if (connectorIds.length) {
      const conns = await db
        .select({ connectorId: executorConnectors.connectorId, slug: executorConnectors.slug })
        .from(executorConnectors)
        .where(inArray(executorConnectors.connectorId, connectorIds));
      for (const conn of conns) slugByConnector.set(conn.connectorId, conn.slug);
    }

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
        connector: r.connectorId ? (slugByConnector.get(r.connectorId) ?? null) : null,
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
        // For an UNRESOLVED row, the standalone page where a human reviews the
        // full (redacted) arguments and decides. Minted here so the in-session
        // notice can link straight to it without a second round trip. Only for
        // pending rows: a resolved row has nothing left to decide, and a
        // settled decision shouldn't carry a live link around.
        approval_url:
          r.status === 'pending_approval' && !r.resolvedAt
            ? approvalPageUrl(projectId, r.executionId, sessionId)
            : null,
      })),
    });
  },
);


// GET /v1/projects/:projectId/sessions/:sessionId/voice-transcript
// The live-call transcript for a session's voice connector call — every spoken
// turn (role 'user'/'agent', from voice_call_turns) PLUS every ask_kortix/
// run_command the worker issued through the voice MCP (role 'tool', recorded
// by mcp.ts's callTool). A session's callId IS its sessionId (see
// channels/voice/runtime.ts's file header), so there is nothing to look up
// beyond the session itself.
//
// `role` alone does not identify a turn — read `speaker` with it:
//   user  + <null>          a human in the room
//   agent + 'kortix'        what the Kortix agent put into the call
//                           (channels/voice/utterance.ts's KORTIX_SPEAKER,
//                           written server-side the moment it is delivered)
//   agent + <bot name>      what the voice actually said, as the worker heard
//                           itself say it (apps/voice-agent/src/transcripts.ts)
//   tool  + <tool name>     an ask_kortix/run_command the worker issued; the
//                           text carries the argument and the outcome
// The two `agent` rows are not duplicates: one is the instruction Kortix sent,
// the other the model's spoken phrasing of it, and either can appear alone.
//
// This is a THIN read wrapper around `readTurns`/`isCallLive` (already used
// internally by the voice runtime) for the one thing they didn't have yet: a
// route a Kortix-authenticated browser session can call. Same visibility gate
// as /transcript and /audit above — project read + the session must be
// visible to the caller — deliberately NOT the worker's per-call HMAC auth
// (routes.ts), which authorizes exactly one call and would be the wrong tool
// for "a person looking at the session in the web app".
//
// `cursor` makes this a plain incremental poll: pass back the `cursor` this
// endpoint returned last time and only new turns come back, in order — the
// same non-blocking "what's new since X" contract `readTurns` already gives
// the voice agent loop.

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/sessions/{sessionId}/voice-transcript',
    tags: ['sessions'],
    summary: 'GET /:projectId/sessions/:sessionId/voice-transcript',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), sessionId: z.string() }),
      query: z.object({ cursor: z.string().optional(), limit: z.string().optional() }),
    },
    responses: {
      200: json(AnyObject, "A session's live voice-call transcript"),
      ...errors(400, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

    const cursor = parseBoundedPositiveInt(c.req.query('cursor'), 0, 0, Number.MAX_SAFE_INTEGER, 'cursor');
    if (!cursor.ok) return c.json({ error: cursor.error }, 400);
    const limit = parseBoundedPositiveInt(c.req.query('limit'), 200, 1, 500, 'limit');
    if (!limit.ok) return c.json({ error: limit.error }, 400);

    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_SESSION_READ);
    const visible = await loadVisibleSession(loaded, sessionId, c.get('sessionId') ?? null);
    if (!visible) return c.json({ error: 'Not found' }, 404);

    const [page, live] = await Promise.all([
      readTurns(sessionId, cursor.value, limit.value),
      isCallLive(sessionId),
    ]);

    return c.json({
      session_id: sessionId,
      call_id: sessionId,
      live,
      cursor: page.cursor,
      count: page.turns.length,
      turns: page.turns,
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
    const loaded = await loadProjectForUser(c, projectId, 'read');
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
        origin: projectSessions.origin,
      })
      .from(projectSessions)
      .where(and(eq(projectSessions.projectId, projectId), inArray(projectSessions.sessionId, kortixIds)));

    const sessions: Record<string, number> = {};
    let total = 0;
    for (const s of sess) {
      // created_by is shared across every KaaB session, so it cannot filter
      // one end-user's pending gates from another's — and an execution_id is
      // all the resolve route needs.
      if (
        !maySeeSessionApprovals({
          isManager,
          targetSessionId: s.sessionId,
          targetSessionOrigin: s.origin ?? null,
          targetSessionCreatedBy: s.createdBy,
          callerUserId: loaded.userId,
          callerSessionId: callerKortixSessionId(c),
        })
      ) {
        continue;
      }
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
    // NO SCOPES. A decision applies to exactly the call that asked for it.
    //
    // This used to accept 'session' ("stop asking for this tool") and
    // 'session_all' ("stop asking for anything"), surfaced as one-click buttons.
    // Both defeated the gate they were attached to: the reflex click that clears
    // today's prompt also silently pre-authorises every later call, including
    // ones with completely different arguments — a mail send to a different
    // recipient never asks again. An approval that can be waived in one click is
    // not a control. A legitimately unattended tool belongs in an explicit
    // `always_run` policy rule, authored deliberately in the Policies panel,
    // where the full rule set is visible.
    //
    // A stale client may still POST `scope` — it is ignored, not honoured.

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
    let targetCreatedBy: string | null = null;
    let targetOrigin: string | null = null;
    if (row.sessionId) {
      const [session] = await db
        .select({ createdBy: projectSessions.createdBy, origin: projectSessions.origin })
        .from(projectSessions)
        // Scope to THIS project too — sessionId is a PK so it's globally unique,
        // but making the project bound explicit keeps the gate self-documenting.
        .where(and(eq(projectSessions.sessionId, row.sessionId), eq(projectSessions.projectId, projectId)))
        .limit(1);
      targetCreatedBy = session?.createdBy ?? null;
      targetOrigin = session?.origin ?? null;
    }
    const verdict = mayResolveApproval({
      isManager,
      targetSessionOrigin: targetOrigin,
      targetSessionCreatedBy: targetCreatedBy,
      callerUserId: loaded.userId,
      callerSessionId: callerKortixSessionId(c),
    });
    if (!verdict.allowed) {
      return c.json(
        verdict.reason === 'session_bound_caller'
          ? {
              error:
                'An agent cannot resolve its own approval — a human must approve or deny this',
              code: 'APPROVAL_REQUIRES_HUMAN',
            }
          : { error: 'Only a project manager or the session launcher can resolve this' },
        403,
      );
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

    try {
      await recordAuditEvent(
        approvalResolvedAuditEvent({
          accountId: loaded.row.accountId,
          projectId,
          sessionId: row.sessionId,
          executionId,
          actorUserId: loaded.userId,
          actionPath: row.actionPath,
          connectorId: row.connectorId,
          decision,
          source: inferAuditSource(c, 'human'),
        }),
      );
    } catch (error) {
      console.error('[approvals] failed to record central audit event', error);
    }

    // Server-side resume — the reliability backstop. A LIVE gated call (the
    // sandbox CLI/MCP pause loop, or an approve within the gateway's 45s hold)
    // picks this decision out of the DB within ~1s, marks it consumed, and the
    // agent's turn resumes in-band — no message needed. When nobody was
    // waiting (an older sandbox image without the pause loop, or a decision
    // after the ~30min poll budget), the resolve would otherwise change
    // nothing the agent can see: its turn already ended on `pending_approval`.
    // So we enqueue a DURABLE continue_session command with a grace-window
    // schedule: the drain re-checks the consumed marker at execution time and
    // either no-ops (a live waiter got there first) or delivers the
    // continuation prompt into the session (approval carry-over then lets the
    // retried call run without re-asking). Queue-backed so it survives this
    // pod dying; idempotency-keyed so a double-resolve can't double-prompt.
    if (row.sessionId) {
      const resumeText =
        decision === 'approve'
          ? `Your pending approval to run ${row.actionPath} was approved — continue.`
          : `Your request to run ${row.actionPath} was denied — continue without it.`;
      try {
        await enqueueContinueSessionCommand({
          source: 'system:approval-resume',
          projectId,
          accountId: loaded.row.accountId,
          sessionId: row.sessionId,
          actorUserId: loaded.userId,
          text: resumeText,
          executionId,
          // > the waiter's 1s decision poll + hold re-issue latency, with margin.
          availableAt: new Date(Date.now() + 6_000),
          idempotencyKey: `approval-resume:${executionId}`,
        });
        // Best-effort fast path: the scheduler drains every ~60s; kick one
        // drain shortly after the grace window so the resume usually lands in
        // seconds. If this pod dies first, the scheduler still delivers.
        setTimeout(() => {
          drainSessionLifecycleQueue({ limit: 5 }).catch(() => {});
        }, 7_000).unref?.();
      } catch (err) {
        console.warn('[approvals] failed to enqueue resume', {
          executionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return c.json({ ok: true });
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

  const visible = await loadVisibleSession(loaded, sessionId, c.get('sessionId') ?? null);
  if (!visible) return c.json({ error: 'Not found' }, 404);
  if (!visible.canManageSharing) {
    return c.json({ error: 'Only the session owner or a project manager can change sharing' }, 403);
  }

  const intent = parseSharingIntent(body, loaded.userId);
  if (!intent) return c.json({ error: 'invalid sharing — mode must be project|private|members' }, 400);

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
        error: 'Sessions using a personal connector profile must remain private',
        code: 'PERSONAL_CONNECTOR_PROFILE_REQUIRES_PRIVATE_SESSION',
      },
      409,
    );
  }

  await setSessionSharing(sessionId, intent);

  const fresh = await loadVisibleSession(loaded, sessionId, c.get('sessionId') ?? null);
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

  // metadata.deletedAt / deletedBy are SERVER-MANAGED soft-delete markers.
  // deleteSession() is the only legitimate writer; they are consumed by
  // isSessionVisibleTo (r7.ts:488 — hides the session from every member's
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
  // name / title_source are owned by the title generator (the SINGLE writer of
  // metadata.name — see projects/session-title-generate.ts). A client that plants
  // a non-placeholder name pre-empts titling permanently, since `needsTitle` and
  // the CAS both then refuse; renaming is `body.name` → metadata.custom_name,
  // which is the supported, non-destructive override.
  const SERVER_MANAGED_METADATA_KEYS = [
    'deletedAt',
    'deletedBy',
    'opencode_model',
    'opencode_model_source',
    'name',
    'title_source',
  ];
  const metadataInput = body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
    ? (body.metadata as Record<string, unknown>)
    : null;
  if (metadataInput) {
    const forgedKey = SERVER_MANAGED_METADATA_KEYS.find((k) => hasOwn(metadataInput, k));
    if (forgedKey) {
      return c.json({ error: `metadata key is server-managed: ${forgedKey}` }, 400);
    }
  }

  const visible = await loadVisibleSession(loaded, sessionId, c.get('sessionId') ?? null);
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
  const metadata = metadataInput;

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
  const visible = await loadVisibleSession(loaded, sessionId, c.get('sessionId') ?? null);
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
    const loaded = await loadProjectForUser(c, projectId, 'read');
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
    const loaded = await loadProjectForUser(c, projectId, 'read');
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
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE);

    // The id belongs to an agent/skill grant (iam_resource_grants). Secrets no
    // longer have a resource grant to remove — secret sharing was retired.
    const removed = await deleteResourceGrant(grantId, projectId);
    if (!removed) return c.json({ error: 'grant not found' }, 404);
    return c.json({ ok: true });
  },
);

/**
 * Read the server-authoritative session scope.
 */
projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/sessions/{sessionId}/scope',
    tags: ['sessions'],
    summary: "Read a session's secret and connector authorization scope",
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), sessionId: z.string() }),
    },
    responses: {
      200: json(SessionScopeSchema, 'Current session scope'),
      ...errors(400, 404, 409),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_SESSION_READ,
    );
    const visible = await loadVisibleSession(loaded, sessionId, callerKortixSessionId(c));
    if (!visible) return c.json({ error: 'Not found' }, 404);
    let grant: Awaited<ReturnType<typeof resolveSessionAgentGrant>>;
    try {
      grant = await resolveSessionAgentGrant({
        projectId,
        repoUrl: loaded.row.repoUrl,
        defaultBranch: loaded.row.defaultBranch,
        manifestPath: loaded.row.manifestPath,
        sessionAgent: visible.row.agentName ?? DEFAULT_AGENT_SENTINEL,
      });
    } catch (err) {
      return c.json(
        {
          error: `could not resolve this agent's grant, so the current scope cannot be determined: ${
            err instanceof Error ? err.message : String(err)
          }`,
          code: 'AGENT_GRANT_UNRESOLVED',
        },
        409,
      );
    }
    const bindings = await resolveEffectiveSessionConnectorBindings({
      accountId: loaded.row.accountId,
      projectId,
      sessionId,
      grantedConnectors: grant?.connectors,
    });
    return c.json({
      secrets_allowlist: visible.row.secretsAllowlist ?? null,
      required_connectors: visible.row.requiredConnectors ?? null,
      connector_bindings: bindings,
      dropped_secrets: [],
      added_secrets: [],
      dropped_bindings: [],
      retroactive: true,
      detail: 'Current session scope.',
    });
  },
);

projectsApp.openapi(
  createRoute({
    method: 'put',
    path: '/{projectId}/sessions/{sessionId}/scope',
    tags: ['sessions'],
    summary: "Re-scope a running session's secrets and connector bindings",
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), sessionId: z.string() }),
      body: {
        content: {
          'application/json': {
            schema: SessionScopeInputSchema,
          },
        },
      },
    },
    responses: {
      200: json(SessionScopeSchema, 'Session re-scoped'),
      ...errors(400, 403, 404, 409),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

    const loaded = await loadProjectForUser(c, projectId, 'session');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_SESSION_STOP,
    );
    assertAgentScope(c, PROJECT_ACTIONS.PROJECT_SESSION_STOP);
    const visible = await loadVisibleSession(loaded, sessionId, callerKortixSessionId(c));
    if (!visible) return c.json({ error: 'Not found' }, 404);
    // Seeing a session is not permission to re-scope it — same gate as the model
    // change, for the same reason.
    if (!mayChangeSessionModel(visible)) {
      return c.json(
        { error: 'Only the session owner or a project manager can re-scope this session' },
        403,
      );
    }

    const parsedBody = SessionScopeInputSchema.safeParse(await readBody(c));
    if (!parsedBody.success) {
      return c.json(
        {
          error: parsedBody.error.issues.map((issue) => issue.message).join('; '),
          code: 'INVALID_SESSION_SCOPE',
        },
        400,
      );
    }
    const body = parsedBody.data;
    const wantsSecrets = Object.hasOwn(body, 'secrets');
    const wantsBindings = Object.hasOwn(body, 'connector_bindings');
    const wantsRequired = Object.hasOwn(body, 'require_connectors');

    // The agent grant is the ceiling for both axes. Resolved from the agent this
    // session actually runs, and fail-closed: if it cannot be established, the
    // re-scope is refused rather than applied against an unverified ceiling.
    let grant: Awaited<ReturnType<typeof resolveSessionAgentGrant>>;
    try {
      grant = await resolveSessionAgentGrant({
        projectId,
        repoUrl: loaded.row.repoUrl,
        defaultBranch: loaded.row.defaultBranch,
        manifestPath: loaded.row.manifestPath,
        sessionAgent: visible.row.agentName ?? DEFAULT_AGENT_SENTINEL,
      });
    } catch (err) {
      return c.json(
        {
          error: `could not resolve this agent's grant, so the new scope cannot be checked against it: ${
            err instanceof Error ? err.message : String(err)
          }`,
          code: 'AGENT_GRANT_UNRESOLVED',
        },
        409,
      );
    }

    const currentDurableBindings = Object.fromEntries(
      (
        await db
          .select({
            alias: projectSessionConnectorBindings.connectorAlias,
            profileId: projectSessionConnectorBindings.profileId,
          })
          .from(projectSessionConnectorBindings)
          .where(
            and(
              eq(projectSessionConnectorBindings.sessionId, sessionId),
              eq(projectSessionConnectorBindings.projectId, projectId),
            ),
          )
      ).map((row) => [row.alias, row.profileId]),
    );
    const currentEffectiveBindings = await resolveEffectiveSessionConnectorBindings({
      accountId: loaded.row.accountId,
      projectId,
      sessionId,
      grantedConnectors: grant?.connectors,
    });
    const currentEffectiveBindingIds = Object.fromEntries(
      Object.entries(currentEffectiveBindings).map(([alias, binding]) => [
        alias,
        binding.authorization_id,
      ]),
    );

    let nextAllowlist = visible.row.secretsAllowlist ?? null;
    let droppedSecrets: string[] = [];
    let addedSecrets: string[] = [];
    if (wantsSecrets) {
      const decided = rescopeSessionSecrets({
        current: visible.row.secretsAllowlist ?? null,
        requested: (body.secrets ?? null) as string[] | null,
        agentGrantEnv: grant?.env,
      });
      if (!decided.ok) return c.json({ error: decided.message, code: decided.code }, 403);
      nextAllowlist = decided.allowlist;
      droppedSecrets = decided.dropped;
      addedSecrets = decided.added;
      if (nextAllowlist !== null && nextAllowlist.length > 0) {
        const availableSecrets = await listResolvedProjectSecrets(projectId, loaded.userId);
        const available = new Set(
          availableSecrets.map((secret) => secret.identifier.toUpperCase()),
        );
        const unavailable = nextAllowlist.filter(
          (identifier) => !available.has(identifier.toUpperCase()),
        );
        if (unavailable.length > 0) {
          return c.json(
            {
              error: `secret identifier is not available: ${unavailable.join(', ')}`,
              code: 'SECRET_IDENTIFIER_NOT_AVAILABLE',
            },
            403,
          );
        }
        const collision = secretKeyCollisionInAllowlist(availableSecrets, nextAllowlist);
        if (collision) {
          return c.json(
            {
              error: `secrets allowlist names multiple identifiers for env key "${collision.key}": ${collision.identifiers.join(', ')}`,
              code: 'SECRET_IDENTIFIER_KEY_COLLISION',
            },
            409,
          );
        }
      }
    }

    let nextBindings = currentDurableBindings;
    let droppedBindings: string[] = [];
    if (wantsBindings) {
      const requested = Object.fromEntries(
        Object.entries(body.connector_bindings ?? {}).map(([alias, value]) => [
          alias,
          value.authorization_id,
        ]),
      );
      const decided = rescopeSessionBindings({
        current: currentEffectiveBindingIds,
        requested,
        grantedConnectors: grant?.connectors,
      });
      if (!decided.ok) return c.json({ error: decided.message, code: decided.code }, 403);
      nextBindings = decided.bindings;
    }

    // `require_connectors` is the one axis that can name an alias with NOTHING
    // connected to it — that is the whole point of it existing separately from
    // bindings, which must carry a profile id. So it is checked against the
    // agent's grant (may this agent use the alias at all?) and never against
    // whether a connection exists: not-yet-connected is the state the caller is
    // deliberately declaring, and the pre-flight turns it into a connect prompt
    // on the next turn.
    let nextRequired = visible.row.requiredConnectors ?? null;
    if (wantsRequired) {
      const requested = (body.require_connectors ?? [])
        .map((alias) => canonicalConnectorAlias(String(alias).trim()))
        .filter((alias) => alias.length > 0);
      const deduped = [...new Set(requested)];
      if (Array.isArray(grant?.connectors)) {
        const granted = new Set(grant.connectors.map(canonicalConnectorAlias));
        const offending = deduped.filter((alias) => !granted.has(alias));
        if (offending.length > 0) {
          return c.json(
            {
              error: `not granted to this agent: ${offending.map(publicConnectorAlias).join(', ')}`,
              code: 'CONNECTOR_NOT_ASSIGNED',
            },
            403,
          );
        }
      }
      nextRequired = deduped.length > 0 ? deduped : null;
    }

    let bindingRows: Array<{
      sessionId: string;
      projectId: string;
      accountId: string;
      connectorAlias: string;
      connectorId: string;
      profileId: string;
      source: 'request';
      createdBy: string;
    }> = [];
    if (wantsBindings) {
      const [ownerServiceAccount] = visible.row.createdBy
        ? await db
            .select({ id: serviceAccounts.serviceAccountId })
            .from(serviceAccounts)
            .where(
              and(
                eq(serviceAccounts.serviceAccountId, visible.row.createdBy),
                eq(serviceAccounts.accountId, loaded.row.accountId),
              ),
            )
            .limit(1)
        : [];
      const validated = await validateSessionConnectorBindings({
        accountId: loaded.row.accountId,
        projectId,
        actingUserId: visible.row.createdBy ?? '',
        actingPrincipalIsServiceAccount: ownerServiceAccount !== undefined,
        mayManageSystemProfiles: false,
        bindings: Object.fromEntries(
          Object.entries(nextBindings).map(([alias, authorizationId]) => [
            alias,
            { authorization_id: authorizationId },
          ]),
        ),
      });
      if (!validated.ok) {
        return c.json({ error: validated.error, code: validated.code }, 403);
      }
      if (
        visible.row.visibility !== 'private' &&
        sessionConnectorBindingsRequirePrivateVisibility(validated.bindings)
      ) {
        return c.json(
          {
            error: 'A user authorization requires a private session',
            code: 'PERSONAL_CONNECTOR_PROFILE_REQUIRES_PRIVATE_SESSION',
          },
          409,
        );
      }
      bindingRows = validated.bindings.map((binding) => ({
        sessionId,
        projectId,
        accountId: loaded.row.accountId,
        connectorAlias: binding.alias,
        connectorId: binding.connectorId,
        profileId: binding.profileId,
        source: 'request' as const,
        createdBy: loaded.userId,
      }));
    }

    await db.transaction(async (tx) => {
      const sessionUpdates: {
        updatedAt: Date;
        secretsAllowlist?: string[] | null;
        requiredConnectors?: string[] | null;
        connectorBindingsConfigured?: boolean;
        connectorBindingsInheritUnbound?: boolean;
      } = { updatedAt: new Date() };
      if (wantsSecrets) sessionUpdates.secretsAllowlist = nextAllowlist;
      if (wantsRequired) sessionUpdates.requiredConnectors = nextRequired;
      if (wantsBindings) {
        sessionUpdates.connectorBindingsConfigured = true;
        // Deliberately NOT touching connectorBindingsInheritUnbound. Forcing it
        // false here meant a single scope save silently cut off project-default
        // fallback for every alias the caller did not re-bind — a session that had
        // been resolving Gmail from the project default simply stopped, with
        // nothing in the request having asked for that. The schema comment still
        // called the flag immutable while this line mutated it.
      }
      await tx
        .update(projectSessions)
        .set(sessionUpdates)
        .where(
          and(
            eq(projectSessions.sessionId, sessionId),
            eq(projectSessions.projectId, projectId),
            eq(projectSessions.accountId, loaded.row.accountId),
          ),
        );
      if (wantsBindings) {
        await tx
          .delete(projectSessionConnectorBindings)
          .where(
            and(
              eq(projectSessionConnectorBindings.sessionId, sessionId),
              eq(projectSessionConnectorBindings.projectId, projectId),
              eq(projectSessionConnectorBindings.accountId, loaded.row.accountId),
            ),
          );
        if (bindingRows.length > 0) {
          await tx.insert(projectSessionConnectorBindings).values(bindingRows);
        }
      }
    });

    const effectiveBindings = await resolveEffectiveSessionConnectorBindings({
      accountId: loaded.row.accountId,
      projectId,
      sessionId,
      grantedConnectors: grant?.connectors,
    });
    if (wantsBindings) {
      droppedBindings = Object.keys(currentEffectiveBindings).filter(
        (alias) => !Object.hasOwn(effectiveBindings, alias),
      );
    }

    // No push needed: the per-prompt hot sync re-reads secretsAllowlist and
    // re-resolves the whole env on the NEXT prompt, and connector bindings are
    // resolved server-side at call time. Pushing here would race that.
    return c.json({
      secrets_allowlist: nextAllowlist,
      required_connectors: nextRequired,
      connector_bindings: effectiveBindings,
      dropped_secrets: droppedSecrets,
      added_secrets: addedSecrets,
      dropped_bindings: droppedBindings,
      // Connector bindings ARE retroactive (resolved at call time). Secrets are
      // not: a dropped one stops being delivered from the next prompt, but the
      // agent's context and any shell it already spawned still hold what it read.
      retroactive: droppedSecrets.length === 0,
      detail:
        droppedSecrets.length > 0
          ? 'Dropped secrets stop being delivered from the next prompt. Values the agent already read remain in its context and in shells it already started — rotate them if that matters.'
          : 'Applies from the next prompt.',
    });
  },
);

/**
 * Change the model a session uses, mid-flight.
 *
 * `opencode_model` was create-only: the sandbox reads `KORTIX_OPENCODE_MODEL`
 * when opencode builds its config at spawn, and nothing re-pushed it — so a live
 * box kept its boot model for the rest of the session. The only way to "change"
 * it was to plant a value through PATCH metadata, which skipped the account
 * servability check entirely (now blocked; see SERVER_MANAGED_METADATA_KEYS).
 *
 * Validates against the SAME resolver the create path uses, persists, then
 * pushes to the live sandbox. The response says whether it is in effect NOW or
 * only from the next boot, because those are genuinely different outcomes and
 * the caller cannot otherwise tell.
 */
projectsApp.openapi(
  createRoute({
    method: 'put',
    path: '/{projectId}/sessions/{sessionId}/model',
    tags: ['sessions'],
    summary: "Change a running session's model",
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), sessionId: z.string() }),
      body: {
        content: {
          'application/json': {
            schema: z.object({ opencode_model: z.string().min(1).max(128) }),
          },
        },
      },
    },
    responses: {
      200: json(
        z.object({
          opencode_model: z.string(),
          /** True when a live sandbox took it; false when it applies at next boot. */
          applied_live: z.boolean(),
          /**
           * Present only when a live push was REQUIRED and FAILED — the row is
           * written but the running harness still answers from the OLD model.
           * `applied_live: false` cannot express this on its own (it is also the
           * benign cold-session answer), so a client must read THIS to tell a
           * half-applied change from a stored one.
           */
          push_failed: z.literal(true).optional(),
          detail: z.string().optional(),
        }),
        'Model changed',
      ),
      ...errors(400, 403, 404, 409),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

    const loaded = await loadProjectForUser(c, projectId, 'session');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    // A live model change restarts opencode and can terminate the target
    // session's in-flight turn. Scoped agent tokens therefore need the same
    // destructive capability as the stop route (no-op for human/PAT tokens).
    assertAgentScope(c, PROJECT_ACTIONS.PROJECT_SESSION_STOP);
    const visible = await loadVisibleSession(loaded, sessionId, c.get('sessionId') ?? null);
    if (!visible) return c.json({ error: 'Not found' }, 404);
    // Seeing a session is not permission to mutate it: visibility 'project'
    // makes it readable by every member, but changing the model restarts
    // opencode and destroys the OWNER's in-flight turn. Same gate as the
    // sharing and stop routes above.
    if (!mayChangeSessionModel(visible)) {
      return c.json(
        { error: 'Only the session owner or a project manager can change this session model' },
        403,
      );
    }

    const body = await readBody(c);
    const requested = typeof body?.opencode_model === 'string' ? body.opencode_model : '';
    const shapeError = validateModelChangeShape(requested);
    if (shapeError) {
      return c.json({ error: shapeError.message, code: shapeError.code }, 400);
    }
    const stateError = canChangeSessionModel(visible.row.status);
    if (stateError) {
      return c.json({ error: stateError.message, code: stateError.code }, 409);
    }

    // Same servability gate as create — otherwise this endpoint becomes the very
    // back door the PATCH guard just closed.
    const trimmed = requested.trim();
    const freeModelsOnly = config.KORTIX_BILLING_INTERNAL_ENABLED
      ? !tierGrantsAllModels(await getCachedAccountTier(loaded.row.accountId))
      : false;
    const servable = await isModelServableForAccount({
      userId: loaded.userId,
      accountId: loaded.row.accountId,
      projectId,
      freeModelsOnly,
      model: trimmed,
    });
    if (!servable) {
      return c.json(
        {
          error: `Model "${trimmed}" is not available for this account`,
          code: 'INVALID_SESSION_MODEL',
        },
        400,
      );
    }

    const nextModel = toOpencodeModelRef(trimmed);
    // The session model lives in metadata, not a column (sessions.ts:1102) —
    // which is precisely why the PATCH metadata back door was dangerous.
    const currentMetadata = (visible.row.metadata ?? {}) as Record<string, unknown>;
    const currentModel =
      typeof currentMetadata.opencode_model === 'string' ? currentMetadata.opencode_model : null;
    const needsPush = modelChangeNeedsLivePush({
      current: currentModel,
      next: nextModel,
      status: visible.row.status,
    });

    await db
      .update(projectSessions)
      .set({
        metadata: {
          ...currentMetadata,
          opencode_model: nextModel,
          opencode_model_source: 'explicit',
        },
        updatedAt: new Date(),
      })
      .where(eq(projectSessions.sessionId, sessionId));

    if (!needsPush) {
      return c.json(
        modelChangeResult({ model: nextModel, needsPush: false, current: currentModel }),
      );
    }

    const push = await pushSessionModelToSandbox({ projectId, sessionId, model: nextModel });
    return c.json(modelChangeResult({ model: nextModel, needsPush: true, push }));
  },
);
