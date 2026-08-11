import { isCallLive, readTurns } from '../../channels/voice/runtime';
import { SessionScopeInputSchema, SessionScopeSchema } from '@kortix/api-contract';
import { approvalResolvedAuditEvent } from '../../connectors/call-audit';
import {
  loadSessionGrants,
  parseSharingIntent,
  resolveShareSubject,
  setSessionSharing,
} from '../../connectors/share';
import {
  WORKSPACE_ACTIONS,
  deleteResourceGrant,
  isCreatableResourceType,
  listResourceGrants,
  upsertResourceGrant,
} from '../../iam';
import { assertAgentScope, isWorkspaceSessionPrincipal } from '../../iam/agent-scope';
import { approvalPageUrl } from '../../setup-links/token';
import { invalidateIamCacheForGroup } from '../../iam/cache-invalidation';
import { normalizeWorkspaceRole } from '../../iam/role-perms';
import {
  workspaceHasResource,
  workspaceResourcesFromConfig,
  loadConfigWithFiles,
} from '../lib/workspace-resources';
import { auth, errors, json } from '../../openapi';
import { DEFAULT_SANDBOX_SLUG } from '../../snapshots/builder';
import { db } from '../../shared/db';
import { inferAuditSource, recordAuditEvent } from '../../shared/audit';
import { roleAllows } from '../access';
import { createRoute, z } from '@hono/zod-openapi';
import {
  accountGroupMembers,
  accountGroups,
  accountMembers,
  auditEvents,
  connectors,
  connectorCalls,
  projectGroupGrants,
  projectSessions,
  sessionLifecycleCommands,
  sessionSandboxes,
  projectSessionConnectorBindings,
  serviceAccounts,
} from '@kortix/db';
import { and, asc, desc, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import { mayResolveApproval, maySeeSessionApprovals } from '../lib/approval-authority';
import { accountMayUseManagedModels } from '../../billing/services/entitlements';
import {
  canChangeSessionModel,
  mayChangeSessionModel,
  modelChangeNeedsLivePush,
  modelChangeResult,
  validateModelChangeShape,
} from '../lib/session-model-change';
import { pushSessionModelToSandbox, pushSessionScopeToSandbox } from '../lib/sandbox-env-sync';
import { isModelServableForAccount } from '../../llm-gateway/resolution/default-model';
import { toOpencodeModelRef } from '../../llm-gateway/resolution/effective';
import {
  loadWorkspaceForUser,
  loadVisibleSession,
  lookupEmailsByUserIds,
  parseExpiresAtBody,
  assertWorkspaceCapability,
  isUuid,
  workspaceCapabilityAllowed,
  resolveSessionOwnerIdentities,
} from '../lib/access';
import {
  AnyObject,
  ClaimWarmWorkspaceSessionInputSchema,
  GroupGrantSchema,
  OkSchema,
  SessionCreateAcceptedSchema,
  SessionCreateInputSchema,
  SessionSchema,
  WarmWorkspaceSessionResultSchema,
  workspaceRoutesApp,
} from '../lib/app';
import {
  UUID_V4_REGEX,
  hasOwn,
  normalizeString,
  readBody,
  requestAuditContext,
  serializeSession,
} from '../lib/serializers';
import {
  createWorkspaceSession,
  sendSessionCreateError,
  type SessionCreateError,
} from '../lib/sessions';
import {
  RequiredConnectorConnectionUnavailableError,
  resolveEffectiveSessionConnectorBindings,
  sessionHasMemberConnectorBinding,
  sessionConnectorBindingsRequirePrivateVisibility,
  validateSessionConnectorBindings,
} from '../lib/session-connector-bindings';
import { buildSessionTranscriptDigest } from '../lib/session-transcript';
import {
  claimAvailableWarmWorkspaceSession,
  discardAvailableWarmWorkspaceSession,
  findAvailableWarmWorkspaceSession,
  withWarmWorkspaceSessionLock,
} from '../lib/warm-session-store';
import { prepareReusedWarmSession } from '../lib/warm-session-refresh';
import { createWarmWorkspaceSessionCoordinator, WarmWorkspaceSessionError } from '../lib/warm-sessions';
import {
  createSession,
  buildContinueSessionCommandValues,
  deleteSession,
  drainSessionLifecycleQueue,
} from '../session-lifecycle';
import { requireEntitlement } from '../../accounts/iam/helpers';
import { accountHasEntitlement } from '../../billing/services/entitlements';
import { buildFilters } from '../../accounts/audit-filters';
import {
  buildAuditCursorCondition,
  parseAuditCursor,
  parseAuditInstant,
  parseAuditLimit,
  parseAuditSessionCursor,
  serializeAuditEvent,
} from '../../shared/audit-query';
import { AuditEventSchema, AuditListSchema } from '../../shared/audit-schema';
import { parseOpenCodeAuditBatch } from '../../shared/opencode-audit-ingestion';
import { callerKortixSessionId } from '../lib/caller-session';
import { sandboxTokenMayActOnSession } from '../lib/sandbox-token-session';
import {
  isConfigStale,
  latestAgentConfigEtag,
  readSandboxConfigState,
  reloadDetail,
  reloadSessionConfig,
} from '../lib/session-reload';
import { canonicalConnectorAlias, publicConnectorAlias } from '../../shared/connector-alias';
import { DEFAULT_AGENT_SENTINEL } from '../agents';
import { resolveSessionAgentGrant } from '../lib/secret-grant';
import { rescopeSessionBindings, rescopeSessionSecrets } from '../lib/session-rescope';
import { listResolvedWorkspaceSecrets, secretKeyCollisionInAllowlist } from '../secrets';
import { selectSessionRowsForViewer, type WorkspaceSessionListScope } from '../lib/session-inventory';
import { missingWarmSessionConnections } from '../lib/warm-session-connections';

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

workspaceRoutesApp.openapi(
  createRoute({
    method: 'get',
    path: '/{workspaceId}/group-grants',
    tags: ['access'],
    summary: 'GET /:workspaceId/group-grants',
    ...auth,
      request: {
        params: z.object({ workspaceId: z.string() }),
      },
    responses: {
        200: json(z.array(GroupGrantSchema), 'Group grants'),
        ...errors(404),
    },
  }),
  async (c: any) => {
  const workspaceId = c.req.param('workspaceId');
  const loaded = await loadWorkspaceForUser(c, workspaceId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertWorkspaceCapability(c, loaded.userId, loaded.row.accountId, workspaceId, WORKSPACE_ACTIONS.WORKSPACE_SESSION_READ);

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
    .where(eq(projectGroupGrants.workspaceId, workspaceId))
    // Deterministic order — without ORDER BY, Postgres can return rows
    // in heap-scan order, which shifts when the row is UPDATEd (e.g., a
    // role change). The UI list would then visibly reshuffle after a
    // role flip. Oldest attachments first matches the "Attached <date>"
    // subtitle most users scan along.
    .orderBy(asc(projectGroupGrants.createdAt), asc(projectGroupGrants.groupId));

  // Per-group member breakdown so the UI can flag attachments where the
  // grant role won't apply uniformly. When a group includes account
  // owners/admins, those users have implicit Manager on every workspace,
  // so the group's grant role is moot for them. Surfacing
  // override_count = N lets the workspace admin see at a glance "this
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
        if (m.isSuperAdmin || m.accountRole === 'owner' || m.accountRole === 'admin') {
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
      typeof detail.body.error === 'string' ? detail.body.error : 'Warm session creation failed',
    );
    this.name = 'WarmSessionCreateFailure';
  }
}

function resolvedWarmSessionConfiguration(workspace: {
  defaultBranch: string;
  metadata: Record<string, unknown> | null;
}) {
  const metadata = workspace.metadata ?? {};
  return {
    baseRef: workspace.defaultBranch,
    agentName: normalizeString(metadata.default_agent) ?? 'default',
    sandboxSlug: normalizeString(metadata.default_sandbox_slug) ?? DEFAULT_SANDBOX_SLUG,
  };
}

function requiredConnectionError(
  connectorConnections: Awaited<ReturnType<typeof missingWarmSessionConnections>>,
): SessionCreateError {
  return {
    status: 409,
    body: {
      code: 'CONNECTOR_CONNECTION_REQUIRED',
      message: 'Create the required connections before starting this session.',
      connector_connections: connectorConnections,
    },
  };
}

function unavailableRequiredConnectorError(
  error: RequiredConnectorConnectionUnavailableError,
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

// POST /v1/workspaces/:workspaceId/sessions/warm

workspaceRoutesApp.openapi(
  createRoute({
    method: 'post',
    path: '/{workspaceId}/sessions/warm',
    tags: ['sessions'],
    summary: 'Create or reuse the current user warm workspace session',
    ...auth,
    request: {
      params: z.object({ workspaceId: z.string() }),
      body: { content: { 'application/json': { schema: z.object({}).strict() } } },
    },
    responses: {
      200: json(WarmWorkspaceSessionResultSchema, 'The available warm session'),
      ...errors(400, 402, 403, 404, 409, 429, 500, 503),
    },
  }),
  async (c: any) => {
    const workspaceId = c.req.param('workspaceId');
    const loaded = await loadWorkspaceForUser(c, workspaceId, 'session');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    assertAgentScope(c, WORKSPACE_ACTIONS.WORKSPACE_SESSION_START);

    const scope = {
      accountId: loaded.row.accountId,
      workspaceId,
      userId: loaded.userId,
    };
    const configuration = resolvedWarmSessionConfiguration(loaded.row);
    const coordinator = createWarmWorkspaceSessionCoordinator({
      exclusive: (operation) => withWarmWorkspaceSessionLock(scope, operation),
      findAvailable: () => findAvailableWarmWorkspaceSession(scope),
      discard: (sessionId, metadata) =>
        discardAvailableWarmWorkspaceSession(scope, sessionId, metadata),
      claim: (sessionId, metadata) => claimAvailableWarmWorkspaceSession(scope, sessionId, metadata),
      create: async (metadata) => {
        const result = await createWorkspaceSession({
          workspace: loaded.row,
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
          inSession: isWorkspaceSessionPrincipal(c),
          callerSessionId: callerKortixSessionId(c),
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
        const missing = await missingWarmSessionConnections(loaded.row, ensured.session);
        if (missing.length > 0) {
          const currentMarker =
            ensured.session.metadata?.warm_session &&
            typeof ensured.session.metadata.warm_session === 'object' &&
            !Array.isArray(ensured.session.metadata.warm_session)
              ? ensured.session.metadata.warm_session
              : {};
          await discardAvailableWarmWorkspaceSession(scope, ensured.session.sessionId, {
            ...(ensured.session.metadata ?? {}),
            warm_session: {
              ...currentMarker,
              state: 'discarded',
              discarded_at: new Date().toISOString(),
              discard_reason: 'connector_authorization_invalid',
            },
          });
          return sendSessionCreateError(c, requiredConnectionError(missing));
        }
      }
      const warmRefresh = ensured.reused
        ? await prepareReusedWarmSession({
            workspace: loaded.row,
            accountId: loaded.row.accountId,
            sessionId: ensured.session.sessionId,
          })
        : {
            workspace: { status: 'skipped' as const },
            config: { status: 'current' as const },
          };
      if (warmRefresh.config.status === 'failed') {
        console.warn('[warm-session] failed to update compiled agent config', {
          workspaceId,
          sessionId: ensured.session.sessionId,
          reason: warmRefresh.config.reason,
        });
      }
      return c.json(
        {
          session: serializeSession(ensured.session, {
            viewerId: loaded.userId,
            canManageWorkspace: roleAllows(loaded.effectiveRole, 'manage'),
          }),
          reused: ensured.reused,
          workspace_refresh: warmRefresh.workspace,
        },
        200,
      );
    } catch (error) {
      if (error instanceof RequiredConnectorConnectionUnavailableError) {
        return sendSessionCreateError(c, unavailableRequiredConnectorError(error));
      }
      if (error instanceof WarmSessionCreateFailure) {
        return sendSessionCreateError(c, error.detail);
      }
      throw error;
    }
  },
);

// POST /v1/workspaces/:workspaceId/sessions/warm/claim

workspaceRoutesApp.openapi(
  createRoute({
    method: 'post',
    path: '/{workspaceId}/sessions/warm/claim',
    tags: ['sessions'],
    summary: 'Claim the current user warm workspace session',
    ...auth,
    request: {
      params: z.object({ workspaceId: z.string() }),
      body: {
        content: {
          'application/json': { schema: ClaimWarmWorkspaceSessionInputSchema },
        },
      },
    },
    responses: {
      200: json(SessionSchema, 'The claimed session'),
      ...errors(400, 403, 404, 409),
    },
  }),
  async (c: any) => {
    const workspaceId = c.req.param('workspaceId');
    const body = await readBody(c);
    const sessionId = normalizeString(body.session_id);
    if (!sessionId || !UUID_V4_REGEX.test(sessionId)) {
      return c.json({ error: 'Invalid session id', code: 'INVALID_SESSION_ID' }, 400);
    }

    const loaded = await loadWorkspaceForUser(c, workspaceId, 'session');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    assertAgentScope(c, WORKSPACE_ACTIONS.WORKSPACE_SESSION_START);

    const scope = {
      accountId: loaded.row.accountId,
      workspaceId,
      userId: loaded.userId,
    };
    const coordinator = createWarmWorkspaceSessionCoordinator({
      findAvailable: () => findAvailableWarmWorkspaceSession(scope),
      discard: (candidateSessionId, metadata) =>
        discardAvailableWarmWorkspaceSession(scope, candidateSessionId, metadata),
      claim: (candidateSessionId, metadata) =>
        claimAvailableWarmWorkspaceSession(scope, candidateSessionId, metadata),
      create: async () => {
        throw new Error('Claim cannot create a warm session');
      },
    });

    try {
      const candidate = await findAvailableWarmWorkspaceSession(scope);
      if (candidate?.sessionId === sessionId) {
        const missing = await missingWarmSessionConnections(loaded.row, candidate);
        if (missing.length > 0) {
          return sendSessionCreateError(c, requiredConnectionError(missing));
        }
      }

      const claimed = await coordinator.claim({
        sessionId,
        agentName: normalizeString(body.agent_name) ?? undefined,
        sandboxSlug: normalizeString(body.sandbox_slug) ?? undefined,
        pendingPrompt:
          body.pending_prompt &&
          typeof body.pending_prompt === 'object' &&
          !Array.isArray(body.pending_prompt)
            ? (body.pending_prompt as Record<string, unknown>)
            : undefined,
      });
      return c.json(
        serializeSession(claimed, {
          viewerId: loaded.userId,
          canManageWorkspace: roleAllows(loaded.effectiveRole, 'manage'),
        }),
        200,
      );
    } catch (error) {
      if (error instanceof RequiredConnectorConnectionUnavailableError) {
        return sendSessionCreateError(c, unavailableRequiredConnectorError(error));
      }
      if (error instanceof WarmWorkspaceSessionError) {
        return c.json({ error: error.message, code: error.code }, error.status as 409);
      }
      throw error;
    }
  },
);

// POST /v1/workspaces/:workspaceId/group-grants
// Attach a group to this workspace at the given role. Idempotent — if the
// group already has a grant, the role is updated.

workspaceRoutesApp.openapi(
  createRoute({
    method: 'post',
    path: '/{workspaceId}/group-grants',
    tags: ['access'],
    summary: 'POST /:workspaceId/group-grants',
    ...auth,
      request: {
        params: z.object({ workspaceId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        201: json(GroupGrantSchema, 'The created group grant'),
        ...errors(400, 404),
    },
  }),
  async (c: any) => {
  const workspaceId = c.req.param('workspaceId');
  const loaded = await loadWorkspaceForUser(c, workspaceId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  // assertWorkspaceCapability (not bare assertAuthorized) so the acting token is
  // threaded and the agent-grant fold fires: an agent-session token must also
  // hold project.members.manage to mutate group grants, not just its user.
    await assertWorkspaceCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      workspaceId,
      WORKSPACE_ACTIONS.WORKSPACE_MEMBERS_MANAGE,
    );
  // Entitlement mirror of accounts/iam/groups.ts so grants can't be minted
  // through the workspace-scoped path when the account-scoped one is gated.
  // Dormant since 2026-07-08: `rbac` is granted on every tier (groups + roles
  // are core collaboration, not an upsell) — it only bites again if the
  // packaging in tiers.ts changes.
  {
    const denied = await requireEntitlement(c, loaded.row.accountId, 'rbac');
    if (denied) return denied;
  }

  const body = await readBody(c);
  const groupId = normalizeString(body.group_id ?? body.groupId);
  // normalizeWorkspaceRole folds the legacy `viewer`/`user` aliases into `member`,
  // so a grant is never persisted with a retired role.
  const role = normalizeWorkspaceRole(body.role);
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
      workspaceId,
      groupId,
      accountId: loaded.row.accountId,
      role,
      grantedBy: loaded.userId,
      expiresAt: expires.value ?? null,
    })
    .onConflictDoUpdate({
      target: [projectGroupGrants.workspaceId, projectGroupGrants.groupId],
      set: {
        role,
        grantedBy: loaded.userId,
        updatedAt: now,
        // Only overwrite when caller explicitly set the field.
        ...(expires.value !== undefined ? { expiresAt: expires.value } : {}),
      },
    });
  await invalidateIamCacheForGroup(groupId);

  return c.json({ workspace_id: workspaceId, group_id: groupId, role }, 201);
},
);

// PATCH /v1/workspaces/:workspaceId/group-grants/:groupId
// Change the role on an existing attachment. Returns 404 when there's
// nothing to change.

workspaceRoutesApp.openapi(
  createRoute({
    method: 'patch',
    path: '/{workspaceId}/group-grants/{groupId}',
    tags: ['access'],
    summary: 'PATCH /:workspaceId/group-grants/:groupId',
    ...auth,
      request: {
        params: z.object({ workspaceId: z.string(), groupId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(400, 404),
    },
  }),
  async (c: any) => {
  const workspaceId = c.req.param('workspaceId');
  const groupId = c.req.param('groupId');
  const loaded = await loadWorkspaceForUser(c, workspaceId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  // assertWorkspaceCapability (not bare assertAuthorized) so the acting token is
  // threaded and the agent-grant fold fires: an agent-session token must also
  // hold project.members.manage to mutate group grants, not just its user.
    await assertWorkspaceCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      workspaceId,
      WORKSPACE_ACTIONS.WORKSPACE_MEMBERS_MANAGE,
    );
  // Same dormant entitlement mirror as the POST above (rbac is on every
  // tier). DELETE below carries no gate at all: revoking access is never
  // paywalled, so an account can always detach grants it can't manage.
  {
    const denied = await requireEntitlement(c, loaded.row.accountId, 'rbac');
    if (denied) return denied;
  }

  const body = await readBody(c);
  const role = normalizeWorkspaceRole(body.role);
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
        and(eq(projectGroupGrants.workspaceId, workspaceId), eq(projectGroupGrants.groupId, groupId)),
    )
    .returning({ groupId: projectGroupGrants.groupId });

  if (result.length === 0) return c.json({ error: 'grant not found' }, 404);
  await invalidateIamCacheForGroup(groupId);
  return c.json({ workspace_id: workspaceId, group_id: groupId, role: body.role });
},
);

// DELETE /v1/workspaces/:workspaceId/group-grants/:groupId
// Detach a group. Members of the group lose access via this grant
// immediately; any direct project_members row they have is unaffected.

workspaceRoutesApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{workspaceId}/group-grants/{groupId}',
    tags: ['access'],
    summary: 'DELETE /:workspaceId/group-grants/:groupId',
    ...auth,
      request: {
        params: z.object({ workspaceId: z.string(), groupId: z.string() }),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(404),
    },
  }),
  async (c: any) => {
  const workspaceId = c.req.param('workspaceId');
  const groupId = c.req.param('groupId');
  const loaded = await loadWorkspaceForUser(c, workspaceId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  // assertWorkspaceCapability (not bare assertAuthorized) so the acting token is
  // threaded and the agent-grant fold fires: an agent-session token must also
  // hold project.members.manage to mutate group grants, not just its user.
    await assertWorkspaceCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      workspaceId,
      WORKSPACE_ACTIONS.WORKSPACE_MEMBERS_MANAGE,
    );

  await db
    .delete(projectGroupGrants)
    .where(
        and(eq(projectGroupGrants.workspaceId, workspaceId), eq(projectGroupGrants.groupId, groupId)),
    );
  await invalidateIamCacheForGroup(groupId);

  return c.json({ ok: true });
},
);

// Session routes. Invariant: session_id == sandbox_id == git branch name.

// POST /v1/workspaces/:workspaceId/sessions

workspaceRoutesApp.openapi(
  createRoute({
    method: 'post',
    path: '/{workspaceId}/sessions',
    tags: ['sessions'],
    summary: 'POST /:workspaceId/sessions',
    ...auth,
      request: {
        params: z.object({ workspaceId: z.string() }),
        body: { content: { 'application/json': { schema: SessionCreateInputSchema } } },
      },
    responses: {
        201: json(SessionSchema, 'The created session'),
        202: json(SessionCreateAcceptedSchema, 'Create accepted; poll the session'),
        ...errors(400, 403, 404, 409),
    },
  }),
  async (c: any) => {
  const workspaceId = c.req.param('workspaceId');
  const body = await readBody(c);
  const loaded = await loadWorkspaceForUser(c, workspaceId, 'session');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  // Per-agent gate: starting a session provisions compute. A scoped agent token
  // must hold project.session.start (no-op for human/PAT tokens).
  assertAgentScope(c, WORKSPACE_ACTIONS.WORKSPACE_SESSION_START);
  const requestedConnectorBindings = body.connector_bindings;
  const mayManageSystemConnections =
    requestedConnectorBindings &&
    typeof requestedConnectorBindings === 'object' &&
    Object.keys(requestedConnectorBindings).length > 0
      ? await workspaceCapabilityAllowed(
          c,
          loaded.userId,
          loaded.row.accountId,
          workspaceId,
          WORKSPACE_ACTIONS.WORKSPACE_SESSION_BINDINGS_WRITE,
        )
      : false;
  // Per-RESOURCE scoping: a member/department can only launch agents they're
  // scoped to. No-op when the agent isn't scoped (unscoped = workspace-wide) and
  // for owner/admins. Mirrors the agent the session core resolves (sessions.ts).
  const launchAgent = normalizeString(body.agent_name ?? body.agentName);
  if (launchAgent) {
    await assertWorkspaceCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      workspaceId,
      WORKSPACE_ACTIONS.WORKSPACE_AGENT_READ,
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
    workspace: loaded.row,
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
    inSession: isWorkspaceSessionPrincipal(c),
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
      canManageWorkspace: roleAllows(loaded.effectiveRole, 'manage'),
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

// GET /v1/workspaces/:workspaceId/sessions

workspaceRoutesApp.openapi(
  createRoute({
    method: 'get',
    path: '/{workspaceId}/sessions',
    tags: ['sessions'],
    summary: 'GET /:workspaceId/sessions',
    ...auth,
      request: {
        params: z.object({ workspaceId: z.string() }),
        query: z.object({
          scope: z.enum(['visible', 'workspace']).optional(),
        }),
      },
    responses: {
        200: json(z.array(SessionSchema), 'Sessions'),
        ...errors(400, 403, 404),
    },
  }),
  async (c) => {
  const workspaceId = c.req.param('workspaceId');
  const scope = (c.req.valid('query').scope ?? 'visible') as WorkspaceSessionListScope;

  const loaded = await loadWorkspaceForUser(c, workspaceId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertWorkspaceCapability(c, loaded.userId, loaded.row.accountId, workspaceId, WORKSPACE_ACTIONS.WORKSPACE_SESSION_READ);

  const rows = await db
    .select()
    .from(projectSessions)
    .where(
      and(
        eq(projectSessions.workspaceId, workspaceId),
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
            eq(sessionSandboxes.workspaceId, workspaceId),
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
  const canManageWorkspace = roleAllows(loaded.effectiveRole, 'manage');
  const grantsBySession = await loadSessionGrants(
    rows.filter((row) => row.visibility === 'restricted').map((row) => row.sessionId),
  );
  const selected = selectSessionRowsForViewer({
    rows,
    scope,
    canManageWorkspace,
    subject,
    grantsBySession,
    runtimeStatusBySession,
    callerSessionId: callerKortixSessionId(c),
  });
  if (!selected.authorized) {
    return c.json({ error: 'Workspace manager access is required to list every session' }, 403);
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
        canManageWorkspace,
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

workspaceRoutesApp.openapi(
  createRoute({
    method: 'get',
    path: '/{workspaceId}/sessions/{sessionId}',
    tags: ['sessions'],
    summary: 'GET /:workspaceId/sessions/:sessionId',
    ...auth,
      request: {
        params: z.object({ workspaceId: z.string(), sessionId: z.string() }),
      },
    responses: {
        200: json(SessionSchema, 'The session'),
        ...errors(400, 404),
    },
  }),
  async (c) => {
  const workspaceId = c.req.param('workspaceId');
  const sessionId = c.req.param('sessionId');
  if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

  const loaded = await loadWorkspaceForUser(c, workspaceId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertWorkspaceCapability(c, loaded.userId, loaded.row.accountId, workspaceId, WORKSPACE_ACTIONS.WORKSPACE_SESSION_READ);

  const visible = await loadVisibleSession(loaded, sessionId, c.get('sessionId') ?? null);
  if (!visible) return c.json({ error: 'Not found' }, 404);
  const ownerEmail = visible.row.createdBy && !visible.isOwner
    ? (await lookupEmailsByUserIds([visible.row.createdBy])).get(visible.row.createdBy) ?? null
    : null;
  return c.json(serializeSession(visible.row, {
    grants: visible.grants,
    viewerId: loaded.userId,
    canManageWorkspace: visible.canManageWorkspace,
    ownerEmail,
  }));
},
);


// GET /v1/workspaces/:workspaceId/sessions/:sessionId/transcript
// Compact server-side transcript read for project automation. Unlike the raw
// /v1/p sandbox proxy, this endpoint is callable with workspace-scoped session
// tokens and strips tool inputs/outputs before returning messages.

workspaceRoutesApp.openapi(
  createRoute({
    method: 'get',
    path: '/{workspaceId}/sessions/{sessionId}/transcript',
    tags: ['sessions'],
    summary: 'GET /:workspaceId/sessions/:sessionId/transcript',
    ...auth,
      request: {
        params: z.object({ workspaceId: z.string(), sessionId: z.string() }),
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
  const workspaceId = c.req.param('workspaceId');
  const sessionId = c.req.param('sessionId');
  if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

  const limit = parseBoundedPositiveInt(c.req.query('limit'), 40, 1, 500, 'limit');
  if (!limit.ok) return c.json({ error: limit.error }, 400);
  const maxChars = parseBoundedPositiveInt(c.req.query('chars'), 700, 80, 5000, 'chars');
  if (!maxChars.ok) return c.json({ error: maxChars.error }, 400);

  const loaded = await loadWorkspaceForUser(c, workspaceId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertWorkspaceCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      workspaceId,
      WORKSPACE_ACTIONS.WORKSPACE_SESSION_READ,
    );

  const visible = await loadVisibleSession(loaded, sessionId, c.get('sessionId') ?? null);
  if (!visible) return c.json({ error: 'Not found' }, 404);

  const transcript = await buildSessionTranscriptDigest({
    session: visible.row,
    workspaceId,
    accountId: loaded.row.accountId,
    userId: loaded.userId,
    limit: limit.value,
    maxChars: maxChars.value,
  });
  return c.json(transcript);
},
);

// GET /v1/workspaces/:workspaceId/audit
// Canonical project slice. It returns the same event contract and cursor as
// the account log, with project_id bound server-side to the authorized project.
// This aggregate oversight surface can include private-session metadata, so it
// requires the workspace-members management capability instead of session read.
workspaceRoutesApp.openapi(
  createRoute({
    method: 'get',
    path: '/{workspaceId}/audit',
    tags: ['workspaces'],
    summary: 'List canonical workspace audit events',
    ...auth,
    request: {
      params: z.object({ workspaceId: z.string().uuid() }),
      query: z.object({
        action: z.string().optional(),
        actor: z.string().uuid().optional(),
        actor_type: z.enum(['human', 'agent', 'service_account', 'system']).optional(),
        session_id: z.string().optional(),
        source: z.string().optional(),
        phase: z.string().optional(),
        outcome: z.enum(['success', 'failure', 'denied', 'pending']).optional(),
        request_id: z.string().optional(),
        correlation_id: z.string().optional(),
        resource_type: z.string().optional(),
        since: z.string().optional(),
        until: z.string().optional(),
        q: z.string().optional(),
        cursor: z.string().optional(),
        limit: z.string().optional(),
      }),
    },
    responses: {
      200: json(AuditListSchema, 'Canonical workspace audit page'),
      ...errors(400, 402, 403, 404),
    },
  }),
  // biome-ignore lint/suspicious/noExplicitAny: Current OpenAPI response unions require the established untyped route-handler boundary.
  async (c: any) => {
    const workspaceId = c.req.param('workspaceId');
    const loaded = await loadWorkspaceForUser(c, workspaceId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertWorkspaceCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      workspaceId,
      WORKSPACE_ACTIONS.WORKSPACE_MEMBERS_MANAGE,
    );
    const denied = await requireEntitlement(c, loaded.row.accountId, 'auditAccess');
    if (denied) return denied;

    const sinceRaw = c.req.query('since')?.trim() || null;
    const untilRaw = c.req.query('until')?.trim() || null;
    let cursor: ReturnType<typeof parseAuditCursor>;
    let limit: number;
    try {
      parseAuditInstant(sinceRaw, 'since');
      parseAuditInstant(untilRaw, 'until');
      cursor = parseAuditCursor(c.req.query('cursor')?.trim() || null);
      limit = parseAuditLimit(c.req.query('limit')?.trim() || null, 50, 200);
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }

    const conditions = buildFilters(loaded.row.accountId, {
      actor: c.req.query('actor')?.trim() || null,
      actorType: c.req.query('actor_type')?.trim() || null,
      workspaceId,
      sessionId: c.req.query('session_id')?.trim() || null,
      source: c.req.query('source')?.trim() || null,
      phase: c.req.query('phase')?.trim() || null,
      outcome: c.req.query('outcome')?.trim() || null,
      requestId: c.req.query('request_id')?.trim() || null,
      correlationId: c.req.query('correlation_id')?.trim() || null,
      actionPrefix: c.req.query('action')?.trim() || null,
      resourceType: c.req.query('resource_type')?.trim() || null,
      sinceRaw,
      untilRaw,
      q: c.req.query('q')?.trim() || null,
    });
    if (cursor) {
      conditions.push(
        buildAuditCursorCondition(cursor, loaded.row.accountId, 'descending'),
      );
    }
    const fetched = await db
      .select()
      .from(auditEvents)
      .where(and(...conditions))
      .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.eventId))
      .limit(limit + 1);
    const hasMore = fetched.length > limit;
    const rows = hasMore ? fetched.slice(0, limit) : fetched;
    const last = rows.at(-1);
    return c.json({
      events: rows.map(serializeAuditEvent),
      next_cursor: hasMore && last ? `${last.occurredAt.toISOString()}|${last.eventId}` : null,
    });
  },
);

// POST /v1/workspaces/:workspaceId/sessions/:sessionId/audit/events
// Authenticated sandbox ingestion. The credential is bound to one project and
// one session. Only redacted summaries and hashes are accepted.
workspaceRoutesApp.openapi(
  createRoute({
    method: 'post',
    path: '/{workspaceId}/sessions/{sessionId}/audit/events',
    tags: ['sessions'],
    summary: 'Ingest an idempotent OpenCode audit batch',
    ...auth,
    request: {
      params: z.object({ workspaceId: z.string().uuid(), sessionId: z.string().uuid() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: { 200: json(AnyObject, 'Batch ingestion result'), ...errors(400, 403, 404) },
  }),
  async (c) => {
    const workspaceId = c.req.param('workspaceId');
    const sessionId = c.req.param('sessionId');
    if (c.get('authType') !== 'apiKey' || c.get('apiKeyType') !== 'sandbox') {
      return c.json({ error: 'audit ingestion requires a sandbox token' }, 403);
    }
    const accountId = c.get('accountId');
    const sandboxId = c.get('sandboxId');
    if (!accountId || !sandboxId || !sandboxTokenMayActOnSession(sandboxId, sessionId)) {
      return c.json({ error: 'sandbox token is not scoped to this session' }, 403);
    }
    const [scope] = await db
      .select({
        sessionId: sessionSandboxes.sessionId,
        opencodeSessionId: projectSessions.opencodeSessionId,
        agentName: projectSessions.agentName,
        createdBy: projectSessions.createdBy,
      })
      .from(sessionSandboxes)
      .innerJoin(
        projectSessions,
        and(
          eq(projectSessions.accountId, sessionSandboxes.accountId),
          eq(projectSessions.workspaceId, sessionSandboxes.workspaceId),
          eq(projectSessions.sessionId, sessionSandboxes.sessionId),
        ),
      )
      .where(
        and(
          eq(sessionSandboxes.sandboxId, sandboxId),
          eq(sessionSandboxes.accountId, accountId),
          eq(sessionSandboxes.workspaceId, workspaceId),
          inArray(sessionSandboxes.status, ['provisioning', 'active']),
        ),
      )
      .limit(1);
    if (!scope || (scope.sessionId ?? sandboxId) !== sessionId) {
      return c.json({ error: 'sandbox token is not scoped to this workspace and session' }, 403);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const identityConditions = [
      and(
        eq(serviceAccounts.workspaceId, workspaceId),
        eq(serviceAccounts.agentName, scope.agentName),
      ),
    ];
    if (scope.createdBy) {
      identityConditions.push(eq(serviceAccounts.serviceAccountId, scope.createdBy));
    }
    const identities = await db
      .select({
        serviceAccountId: serviceAccounts.serviceAccountId,
        agentName: serviceAccounts.agentName,
      })
      .from(serviceAccounts)
      .where(and(eq(serviceAccounts.accountId, accountId), or(...identityConditions)));
    const agentIdentity = identities.find((identity) => identity.agentName === scope.agentName);
    const initiatorIdentity = scope.createdBy
      ? identities.find((identity) => identity.serviceAccountId === scope.createdBy)
      : null;

    let parsed: ReturnType<typeof parseOpenCodeAuditBatch>;
    try {
      parsed = parseOpenCodeAuditBatch(body, {
        accountId,
        workspaceId,
        sessionId,
        trustedProvenance: {
          opencodeSessionId: scope.opencodeSessionId,
          agentId: agentIdentity?.serviceAccountId ?? null,
          agentName: scope.agentName,
          initiatorActorType: initiatorIdentity
            ? 'service_account'
            : scope.createdBy
              ? 'human'
              : 'system',
          initiatorActorId: scope.createdBy,
          correlationId: sessionId,
          causationId: null,
          delegationDepth: 0,
        },
      });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
    const inserted = await db
      .insert(auditEvents)
      .values(parsed.values)
      .onConflictDoNothing()
      .returning({ eventId: auditEvents.eventId });
    return c.json({
      accepted: parsed.accepted,
      inserted: inserted.length,
      duplicates: parsed.accepted - inserted.length,
    });
  },
);

// GET /v1/workspaces/:workspaceId/sessions/:sessionId/audit
// Per-session audit log. `events` is the canonical ordered reconstruction
// timeline. `actions` preserves the governed connector approval projection.
// Same visibility gate as the session detail/transcript (project read + the
// session must be visible to the caller). Non-Enterprise accounts get only the
// unresolved pending approvals (never a 402 — see the entitlement note below).

workspaceRoutesApp.openapi(
  createRoute({
    method: 'get',
    path: '/{workspaceId}/sessions/{sessionId}/audit',
    tags: ['sessions'],
    summary: 'GET /:workspaceId/sessions/:sessionId/audit',
    ...auth,
    request: {
      params: z.object({ workspaceId: z.string(), sessionId: z.string() }),
      query: z.object({
        limit: z.string().optional(),
        cursor: z.string().optional(),
        include_events: z.enum(['true', 'false']).optional(),
      }),
    },
    responses: {
      200: json(
        z.object({
          session_id: z.string(),
          agent: z.string().nullable(),
          audit_access: z.boolean(),
          count: z.number().int(),
          events: z.array(AuditEventSchema),
          next_cursor: z.string().nullable(),
          actions: z.array(z.record(z.unknown())),
        }),
        'Canonical per-session reconstruction log and connector approval projection',
      ),
      ...errors(400, 404),
    },
  }),
  // biome-ignore lint/suspicious/noExplicitAny: Current OpenAPI response unions require the established untyped route-handler boundary.
  async (c: any) => {
    const workspaceId = c.req.param('workspaceId');
    const sessionId = c.req.param('sessionId');
    if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

    let limit: number;
    let cursor: ReturnType<typeof parseAuditSessionCursor>;
    try {
      limit = parseAuditLimit(c.req.query('limit')?.trim() || null, 200, 1000);
      cursor = parseAuditSessionCursor(c.req.query('cursor')?.trim() || null);
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }

    const loaded = await loadWorkspaceForUser(c, workspaceId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertWorkspaceCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      workspaceId,
      WORKSPACE_ACTIONS.WORKSPACE_SESSION_READ,
    );
    const visible = await loadVisibleSession(loaded, sessionId, callerKortixSessionId(c));
    if (!visible) return c.json({ error: 'Not found' }, 404);
    // The historical trail is Enterprise (`auditAccess`), but this endpoint is
    // also the approval CONTROL PLANE: write/destructive connector actions
    // default to require_approval on every tier (connector/policy.ts), the web
    // app polls this route from every open session to render the approval
    // prompt, and it is the launcher's only view of what's blocking the run.
    // A 402 here breaks approvals for every non-Enterprise account (and toasts
    // the upsell on each poll) — so unentitled accounts degrade to unresolved
    // pending approvals only instead of being denied.
    const audited = await accountHasEntitlement(loaded.row.accountId, 'auditAccess');
    const includeEvents = c.req.query('include_events') !== 'false';

    // `session_id` is the integrity-chain scope and is globally unique. The
    // visibility gate above already proves that the caller may read this
    // workspace session. Some request-level events are written before account
    // resolution (`auth.login.success`) or from a project-neutral endpoint
    // (`GET /v1/skills`). Those rows still belong to this session's chain. An
    // account/project predicate would remove the middle row while returning its
    // successor, which makes a valid persisted chain impossible to verify.
    const eventConditions = [eq(auditEvents.sessionId, sessionId)];
    if (cursor) {
      const cursorCondition = or(
        gt(auditEvents.sessionSequence, cursor.sequence),
        and(
          eq(auditEvents.sessionSequence, cursor.sequence),
          gt(auditEvents.eventId, cursor.eventId),
        ),
      );
      if (cursorCondition) eventConditions.push(cursorCondition);
    }
    const fetchedEvents = audited && includeEvents
      ? await db
          .select()
          .from(auditEvents)
          .where(and(...eventConditions))
          .orderBy(asc(auditEvents.sessionSequence), asc(auditEvents.eventId))
          .limit(limit + 1)
      : [];
    const hasMoreEvents = fetchedEvents.length > limit;
    const eventRows = hasMoreEvents ? fetchedEvents.slice(0, limit) : fetchedEvents;
    const lastEvent = eventRows.at(-1);

    const rows = await db
      .select({
        executionId: connectorCalls.executionId,
        connectorId: connectorCalls.connectorId,
        actionPath: connectorCalls.actionPath,
        actingUserId: connectorCalls.actingUserId,
        status: connectorCalls.status,
        risk: connectorCalls.risk,
        resultSummary: connectorCalls.resultSummary,
        approvedBy: connectorCalls.approvedBy,
        createdAt: connectorCalls.createdAt,
        resolvedAt: connectorCalls.resolvedAt,
      })
      .from(connectorCalls)
      .where(
        and(
          eq(connectorCalls.workspaceId, workspaceId),
          eq(connectorCalls.sessionId, sessionId),
          ...(audited
            ? []
            : [
                eq(connectorCalls.status, 'pending_approval'),
                isNull(connectorCalls.approvedBy),
                isNull(connectorCalls.resolvedAt),
              ]),
        ),
      )
      // Most-recent-first: when a busy session exceeds `limit`, keep the RECENT
      // actions (truncating oldest), not the other way round.
      .orderBy(desc(connectorCalls.createdAt))
      .limit(limit);

    // Resolve actor + approver emails in one batched lookup (managers see who).
    const userIds = [
      ...new Set(
        rows.flatMap((r) => [r.actingUserId, r.approvedBy]).filter((v): v is string => !!v),
      ),
    ];
    const emailByUser = userIds.length
      ? await lookupEmailsByUserIds(userIds)
      : new Map<string, string>();

    // Connector slugs in one batched lookup — the UI needs `<slug>.<action>`
    // to offer an "always run this" workspace-policy shortcut on a pending row.
    const connectorIds = [
      ...new Set(rows.map((r) => r.connectorId).filter((v): v is string => !!v)),
    ];
    const slugByConnector = new Map<string, string>();
    if (connectorIds.length) {
      const conns = await db
        .select({ connectorId: connectors.connectorId, slug: connectors.slug })
        .from(connectors)
        .where(inArray(connectors.connectorId, connectorIds));
      for (const conn of conns) slugByConnector.set(conn.connectorId, conn.slug);
    }

    return c.json({
      session_id: sessionId,
      agent: (visible.row.agentName as string | null) ?? null,
      // False when the account lacks the Enterprise `auditAccess` entitlement:
      // `actions` then contains only unresolved pending approvals, and the UI
      // shows the upgrade path for the full trail.
      audit_access: audited,
      count: audited ? eventRows.length : rows.length,
      events: eventRows.map(serializeAuditEvent),
      next_cursor:
        hasMoreEvents && lastEvent?.sessionSequence != null
          ? `${lastEvent.sessionSequence}|${lastEvent.eventId}`
          : null,
      // Most-recent-first trail of every connector-gated action this session took.
      actions: rows.map((r) => ({
        execution_id: r.executionId,
        action: r.actionPath,
        connector_id: r.connectorId,
        connector: r.connectorId ? (slugByConnector.get(r.connectorId) ?? null) : null,
        status: r.status, // ok | error | denied | pending_approval
        risk: r.risk, // read | write | destructive | null
        acted_by: r.actingUserId,
        acted_by_email: r.actingUserId ? (emailByUser.get(r.actingUserId) ?? null) : null,
        // Who resolved a gated action — set for BOTH approve and deny (the
        // approvedBy column doubles as "resolver"). null while still pending.
        resolved_by: r.approvedBy,
        resolved_by_email: r.approvedBy ? (emailByUser.get(r.approvedBy) ?? null) : null,
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
            ? approvalPageUrl(workspaceId, r.executionId, sessionId)
            : null,
      })),
    });
  },
);

// GET /v1/workspaces/:workspaceId/sessions/:sessionId/voice-transcript
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

workspaceRoutesApp.openapi(
  createRoute({
    method: 'get',
    path: '/{workspaceId}/sessions/{sessionId}/voice-transcript',
    tags: ['sessions'],
    summary: 'GET /:workspaceId/sessions/:sessionId/voice-transcript',
    ...auth,
    request: {
      params: z.object({ workspaceId: z.string(), sessionId: z.string() }),
      query: z.object({ cursor: z.string().optional(), limit: z.string().optional() }),
    },
    responses: {
      200: json(AnyObject, "A session's live voice-call transcript"),
      ...errors(400, 404),
    },
  }),
  async (c: any) => {
    const workspaceId = c.req.param('workspaceId');
    const sessionId = c.req.param('sessionId');
    if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

    const cursor = parseBoundedPositiveInt(
      c.req.query('cursor'),
      0,
      0,
      Number.MAX_SAFE_INTEGER,
      'cursor',
    );
    if (!cursor.ok) return c.json({ error: cursor.error }, 400);
    const limit = parseBoundedPositiveInt(c.req.query('limit'), 200, 1, 500, 'limit');
    if (!limit.ok) return c.json({ error: limit.error }, 400);

    const loaded = await loadWorkspaceForUser(c, workspaceId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertWorkspaceCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      workspaceId,
      WORKSPACE_ACTIONS.WORKSPACE_SESSION_READ,
    );
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

// GET /v1/workspaces/:workspaceId/approvals
// The approval inbox: connector actions a policy gated as `require_approval` that
// are still awaiting a human decision (status=pending_approval, unresolved).
// Manager-scoped — this is the workspace-wide oversight surface. A session's own
// launcher also sees + resolves the pending items for their session via the
// per-session audit view + the POST below.

workspaceRoutesApp.openapi(
  createRoute({
    method: 'get',
    path: '/{workspaceId}/approvals',
    tags: ['access'],
    summary: 'GET /:workspaceId/approvals',
    ...auth,
    request: {
      params: z.object({ workspaceId: z.string() }),
      query: z.object({ limit: z.string().optional() }),
    },
    responses: {
      200: json(AnyObject, 'Pending approval inbox'),
      ...errors(400, 404),
    },
  }),
  async (c: any) => {
    const workspaceId = c.req.param('workspaceId');
    const loaded = await loadWorkspaceForUser(c, workspaceId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertWorkspaceCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      workspaceId,
      WORKSPACE_ACTIONS.WORKSPACE_MEMBERS_MANAGE,
    );

    const limit = parseBoundedPositiveInt(c.req.query('limit'), 100, 1, 500, 'limit');
    if (!limit.ok) return c.json({ error: limit.error }, 400);

    const rows = await db
      .select({
        executionId: connectorCalls.executionId,
        actionPath: connectorCalls.actionPath,
        risk: connectorCalls.risk,
        sessionId: connectorCalls.sessionId,
        actingUserId: connectorCalls.actingUserId,
        resultSummary: connectorCalls.resultSummary,
        createdAt: connectorCalls.createdAt,
      })
      .from(connectorCalls)
      .where(
        and(
          eq(connectorCalls.workspaceId, workspaceId),
          eq(connectorCalls.status, 'pending_approval'),
          isNull(connectorCalls.approvedBy),
          isNull(connectorCalls.resolvedAt),
        ),
      )
      .orderBy(desc(connectorCalls.createdAt))
      .limit(limit.value);

    const userIds = [...new Set(rows.map((r) => r.actingUserId).filter((v): v is string => !!v))];
    const emailByUser = userIds.length
      ? await lookupEmailsByUserIds(userIds)
      : new Map<string, string>();

    return c.json({
      count: rows.length,
      approvals: rows.map((r) => ({
        execution_id: r.executionId,
        action: r.actionPath,
        risk: r.risk,
        session_id: r.sessionId,
        requested_by: r.actingUserId,
        requested_by_email: r.actingUserId ? (emailByUser.get(r.actingUserId) ?? null) : null,
        requested_at: r.createdAt.toISOString(),
        detail: r.resultSummary ?? null,
      })),
    });
  },
);

// GET /v1/workspaces/:workspaceId/approvals/needs-input
// Lightweight per-session summary for the sidebar "needs input" indicator: which
// sessions have a connector call awaiting a human decision, and how many. A
// project MANAGER sees every session; everyone else sees only the sessions they
// LAUNCHED (mirrors who may resolve). Read-gated + cheap enough to poll.

workspaceRoutesApp.openapi(
  createRoute({
    method: 'get',
    path: '/{workspaceId}/approvals/needs-input',
    tags: ['access'],
    summary: 'GET /:workspaceId/approvals/needs-input',
    ...auth,
    request: { params: z.object({ workspaceId: z.string() }) },
    responses: {
      200: json(AnyObject, 'Sessions awaiting a human decision'),
      ...errors(400, 404),
    },
  }),
  async (c: any) => {
    const workspaceId = c.req.param('workspaceId');
    const loaded = await loadWorkspaceForUser(c, workspaceId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);

    // Managers see every session's pending items; others only their own launched
    // sessions (same principal set the resolve endpoint accepts).
    let isManager = false;
    try {
      await assertWorkspaceCapability(
        c,
        loaded.userId,
        loaded.row.accountId,
        workspaceId,
        WORKSPACE_ACTIONS.WORKSPACE_MEMBERS_MANAGE,
      );
      isManager = true;
    } catch {
      isManager = false;
    }

    // Every unresolved pending action in the workspace, by session. (No DB join:
    // connector_calls.session_id is `uuid` while project_sessions.session_id
    // is `text` — cross-type equality errors in Postgres, so we resolve in JS
    // where both surface as strings.)
    const pendingRows = await db
      .select({ sessionId: connectorCalls.sessionId })
      .from(connectorCalls)
      .where(
        and(
          eq(connectorCalls.workspaceId, workspaceId),
          eq(connectorCalls.status, 'pending_approval'),
          isNull(connectorCalls.approvedBy),
          isNull(connectorCalls.resolvedAt),
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
      .where(
        and(
          eq(projectSessions.workspaceId, workspaceId),
          inArray(projectSessions.sessionId, kortixIds),
        ),
      );

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

// POST /v1/workspaces/:workspaceId/approvals/:executionId
// Resolve a pending approval — { decision: 'approve' | 'deny' }. Allowed for a
// project MANAGER or the LAUNCHER of the session the action belongs to (the two
// principals a human-in-the-loop approval should recognise). Records who decided
// + when; idempotent-safe (a non-pending row 409s).

workspaceRoutesApp.openapi(
  createRoute({
    method: 'post',
    path: '/{workspaceId}/approvals/{executionId}',
    tags: ['access'],
    summary: 'POST /:workspaceId/approvals/:executionId',
    ...auth,
    request: {
      params: z.object({ workspaceId: z.string(), executionId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      200: json(OkSchema, 'Resolved'),
      ...errors(400, 403, 404, 409),
    },
  }),
  async (c: any) => {
    const workspaceId = c.req.param('workspaceId');
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

    const loaded = await loadWorkspaceForUser(c, workspaceId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);

    const [row] = await db
      .select({
        executionId: connectorCalls.executionId,
        sessionId: connectorCalls.sessionId,
        actingUserId: connectorCalls.actingUserId,
        connectorId: connectorCalls.connectorId,
        actionPath: connectorCalls.actionPath,
        status: connectorCalls.status,
        approvedBy: connectorCalls.approvedBy,
        resolvedAt: connectorCalls.resolvedAt,
        resultSummary: connectorCalls.resultSummary,
      })
      .from(connectorCalls)
      .where(
        and(eq(connectorCalls.executionId, executionId), eq(connectorCalls.workspaceId, workspaceId)),
      )
      .limit(1);
    if (!row) return c.json({ error: 'Not found' }, 404);
    if (row.status !== 'pending_approval' || row.approvedBy || row.resolvedAt) {
      return c.json({ error: 'Approval already resolved' }, 409);
    }

    // Who may resolve: a project MANAGER (the same project.members.manage IAM
    // gate the inbox uses — capability-consistent, so a custom role holding the
    // leaf without the "manager" label still qualifies), OR the human who
    // launched the session the gated action belongs to. (Founder decision:
    // managers + launcher.) assertWorkspaceCapability throws on denial, so probe
    // it — a non-manager launcher must still fall through.
    let isManager = false;
    try {
      await assertWorkspaceCapability(
        c,
        loaded.userId,
        loaded.row.accountId,
        workspaceId,
        WORKSPACE_ACTIONS.WORKSPACE_MEMBERS_MANAGE,
      );
      isManager = true;
    } catch {
      isManager = false;
    }
    let targetCreatedBy: string | null = row.sessionId ? null : row.actingUserId;
    let targetOrigin: string | null = row.sessionId ? null : 'user';
    if (row.sessionId) {
      const [session] = await db
        .select({ createdBy: projectSessions.createdBy, origin: projectSessions.origin })
        .from(projectSessions)
        // Scope to THIS workspace too — sessionId is a PK so it's globally unique,
        // but making the workspace bound explicit keeps the gate self-documenting.
        .where(
          and(
            eq(projectSessions.sessionId, row.sessionId),
            eq(projectSessions.workspaceId, workspaceId),
          ),
        )
        .limit(1);
      targetCreatedBy = session?.createdBy ?? null;
      targetOrigin = session?.origin ?? null;
    }
    const verdict = mayResolveApproval({
      isManager,
      targetSessionOrigin: targetOrigin,
      targetSessionCreatedBy: targetCreatedBy,
      callerUserId: loaded.userId,
      callerAuthType: (c.get('authType') as string | undefined) ?? null,
      callerSessionId: callerKortixSessionId(c),
    });
    if (!verdict.allowed) {
      return c.json(
        verdict.reason === 'session_bound_caller'
          ? {
              error: 'An agent cannot resolve its own approval — a human must approve or deny this',
              code: 'APPROVAL_REQUIRES_HUMAN',
            }
          : verdict.reason === 'non_human_caller'
            ? {
                error: 'Sign in with a Kortix account to resolve this approval',
                code: 'APPROVAL_REQUIRES_HUMAN',
              }
            : { error: 'Only a workspace manager or the session launcher can resolve this' },
        403,
      );
    }

    const existingDetail =
      typeof row.resultSummary === 'object' && row.resultSummary ? row.resultSummary : {};
    if (decision === 'approve' && existingDetail.args_preview_complete !== true) {
      return c.json(
        {
          error: 'The complete connector parameters are not available for review',
          code: 'APPROVAL_PREVIEW_INCOMPLETE',
        },
        409,
      );
    }

    const detail = {
      ...existingDetail,
      decision,
      decided_by: loaded.userId,
    };
    // Atomic resolve — guard the UPDATE on the still-pending state so two
    // concurrent resolvers can't both win (TOCTOU): approve clears the gate to
    // the terminal `ok` (the real retried call re-audits as its own row), deny
    // flips it to `denied`. Both stamp approvedBy (= who resolved) + resolvedAt,
    // so the row leaves the pending inbox. A lost race matches 0 rows → 409.
    const resumeText = row.sessionId
      ? decision === 'approve'
        ? `Your pending approval to run ${row.actionPath} was approved — continue.`
        : `Your request to run ${row.actionPath} was denied — continue without it.`
      : null;
    const callbackValues =
      row.sessionId && resumeText
      ? buildContinueSessionCommandValues({
          source: 'system:approval-resume',
          workspaceId,
          accountId: loaded.row.accountId,
          sessionId: row.sessionId,
          actorUserId: loaded.userId,
          text: resumeText,
          executionId,
          availableAt: new Date(),
          idempotencyKey: `approval-resume:${executionId}`,
        })
      : null;
    const resolved = await db.transaction(async (tx) => {
      const updated = await tx
        .update(connectorCalls)
        .set({
          status: decision === 'approve' ? 'ok' : 'denied',
          approvedBy: loaded.userId,
          resolvedAt: new Date(),
          resultSummary: detail,
        })
        .where(
          and(
            eq(connectorCalls.executionId, executionId),
            eq(connectorCalls.workspaceId, workspaceId),
            eq(connectorCalls.status, 'pending_approval'),
            isNull(connectorCalls.approvedBy),
            isNull(connectorCalls.resolvedAt),
          ),
        )
        .returning({ id: connectorCalls.executionId });
      if (updated.length > 0 && callbackValues) {
        await tx
          .insert(sessionLifecycleCommands)
          .values(callbackValues)
          .onConflictDoNothing({ target: sessionLifecycleCommands.idempotencyKey });
      }
      return updated;
    });

    if (resolved.length === 0) {
      return c.json({ error: 'Approval already resolved' }, 409);
    }

    try {
      await recordAuditEvent(
        approvalResolvedAuditEvent({
          accountId: loaded.row.accountId,
          workspaceId,
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

    // Decision callback. The connector HTTP call returned the approval URL and
    // ended. A human decision now enqueues one durable continue_session command
    // and starts a drain immediately. The next exact call claims the approved
    // request digest once. A changed payload creates a new approval instead.
    if (row.sessionId) {
      // Best-effort immediate webhook-like delivery. The transaction above
      // already persisted the callback with the decision as one atomic outbox.
      void drainSessionLifecycleQueue({
        limit: 1,
        idempotencyKey: `approval-resume:${executionId}`,
      }).catch(() => {});
    }

    return c.json({ ok: true });
  },
);

// PUT /v1/workspaces/:workspaceId/sessions/:sessionId/sharing
// Owner or workspace manager sets who can see/open this session
// (private | project | members). Mirrors connector/secret sharing.

workspaceRoutesApp.openapi(
  createRoute({
    method: 'put',
    path: '/{workspaceId}/sessions/{sessionId}/sharing',
    tags: ['sessions'],
    summary: 'PUT /:workspaceId/sessions/:sessionId/sharing',
    ...auth,
      request: {
        params: z.object({ workspaceId: z.string(), sessionId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(400, 403, 404, 409),
    },
  }),
  async (c: any) => {
  const workspaceId = c.req.param('workspaceId');
  const sessionId = c.req.param('sessionId');
  if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

  const body = await readBody(c);
  const loaded = await loadWorkspaceForUser(c, workspaceId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const visible = await loadVisibleSession(loaded, sessionId, c.get('sessionId') ?? null);
  if (!visible) return c.json({ error: 'Not found' }, 404);
  if (!visible.canManageSharing) {
      return c.json(
        { error: 'Only the session owner or a workspace manager can change sharing' },
        403,
      );
  }

  const intent = parseSharingIntent(body, loaded.userId);
    if (!intent)
      return c.json({ error: 'invalid sharing — mode must be project|private|members' }, 400);

  if (
    intent.mode !== 'private' &&
    (await sessionHasMemberConnectorBinding({
      accountId: loaded.row.accountId,
      workspaceId,
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

  const fresh = await loadVisibleSession(loaded, sessionId, c.get('sessionId') ?? null);
    return c.json(
      fresh
        ? serializeSession(fresh.row, {
    grants: fresh.grants,
    viewerId: loaded.userId,
    canManageWorkspace: fresh.canManageWorkspace,
          })
        : { ok: true },
    );
},
);

// PATCH /v1/workspaces/:workspaceId/sessions/:sessionId

workspaceRoutesApp.openapi(
  createRoute({
    method: 'patch',
    path: '/{workspaceId}/sessions/{sessionId}',
    tags: ['sessions'],
    summary: 'PATCH /:workspaceId/sessions/:sessionId',
    ...auth,
      request: {
        params: z.object({ workspaceId: z.string(), sessionId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        200: json(SessionSchema, 'The updated session'),
        ...errors(400, 404),
    },
  }),
  async (c) => {
  const workspaceId = c.req.param('workspaceId');
  const sessionId = c.req.param('sessionId');
  if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

  const body = await readBody(c);
  const loaded = await loadWorkspaceForUser(c, workspaceId, 'session');
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
    const metadataInput =
      body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
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
      .where(
        and(
      eq(projectSessions.sessionId, sessionId),
      eq(projectSessions.workspaceId, workspaceId),
      eq(projectSessions.accountId, loaded.row.accountId),
        ),
      )
    .returning();

  if (!row) return c.json({ error: 'Not found' }, 404);
    return c.json(
      serializeSession(row, {
    grants: visible.grants,
    viewerId: loaded.userId,
    canManageWorkspace: visible.canManageWorkspace,
      }),
    );
},
);

// DELETE /v1/workspaces/:workspaceId/sessions/:sessionId
// Soft delete only. We deliberately keep the remote branch so the user can
// still merge or recover work.

workspaceRoutesApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{workspaceId}/sessions/{sessionId}',
    tags: ['sessions'],
    summary: 'DELETE /:workspaceId/sessions/:sessionId',
    ...auth,
      request: {
        params: z.object({ workspaceId: z.string(), sessionId: z.string() }),
      },
    responses: {
        200: json(OkSchema, 'Session stopped'),
        ...errors(400, 403, 404),
    },
  }),
  async (c) => {
  const workspaceId = c.req.param('workspaceId');
  const sessionId = c.req.param('sessionId');
  if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

  const loaded = await loadWorkspaceForUser(c, workspaceId, 'session');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  // Per-agent gate: tearing down a session. A scoped agent token must hold
  // project.session.stop (no-op for human/PAT tokens).
  assertAgentScope(c, WORKSPACE_ACTIONS.WORKSPACE_SESSION_STOP);

  // Stopping a session is reserved for its owner or a workspace manager.
  const visible = await loadVisibleSession(loaded, sessionId, c.get('sessionId') ?? null);
  if (!visible) return c.json({ error: 'Not found' }, 404);
  if (!visible.canManageSharing) {
      return c.json(
        { error: 'Only the session owner or a workspace manager can stop this session' },
        403,
      );
  }

  const result = await deleteSession({
    workspaceId,
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
// workspace-wide. All three routes gate on project.members.manage (same as the
// group-grant routes) and thread the acting token so the agent-grant fold fires.

// GET /v1/workspaces/:workspaceId/resource-grants
// Returns the workspace's grantable resources (for the picker) + every grant,
// each enriched with a principal label so the UI needn't re-join.
workspaceRoutesApp.openapi(
  createRoute({
    method: 'get',
    path: '/{workspaceId}/resource-grants',
    tags: ['access'],
    summary: 'GET /:workspaceId/resource-grants',
    ...auth,
    request: { params: z.object({ workspaceId: z.string() }) },
    responses: { 200: json(z.any(), 'Resource grants + grantable resources'), ...errors(404) },
  }),
  async (c: any) => {
    const workspaceId = c.req.param('workspaceId');
    const loaded = await loadWorkspaceForUser(c, workspaceId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    // Manager-only: this is the grant PICKER — it returns the FULL agent/skill
    // catalogue + granted-member emails, so it must NOT be readable by a scoped
    // member (who'd otherwise enumerate exactly what they were scoped away from).
    // Gate identical to the POST/DELETE siblings below.
    await assertWorkspaceCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      workspaceId,
      WORKSPACE_ACTIONS.WORKSPACE_MEMBERS_MANAGE,
    );

    // Enumerate grantable resources from the workspace config (best-effort: a repo
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
      const fromConfig = workspaceResourcesFromConfig(config);
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
        workspaceId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // Grants key on the agent NAME / skill SLUG. A rename or delete of the
    // underlying resource leaves the grant ORPHANED — and since an unscoped
    // resource is workspace-wide, the restriction silently evaporates. Flag
    // orphaned grants so the manager gets a SIGNAL to re-grant.
    // Only checked when the config actually loaded (a transient repo failure
    // must not mass-flag).
    const liveAgentIds = new Set(resources.agents.map((r) => r.id));
    const liveSkillIds = new Set(resources.skills.map((r) => r.id));
    const isOrphan = (type: string, id: string) => {
      if (!configLoaded) return false;
      return type === 'agent'
        ? !liveAgentIds.has(id)
        : type === 'skill'
          ? !liveSkillIds.has(id)
          : false;
    };

    // Agents/skills come from iam_resource_grants. SECRETS no longer have a
    // resource-type here — secret sharing was retired (a secret is always
    // workspace-wide; the only access gate is the agent-side `secrets` grant).
    const grants = (await listResourceGrants(workspaceId)).filter((g) => g.resourceType !== 'secret');

    // Resolve principal labels in two batched lookups.
    const memberIds = [
      ...new Set(grants.filter((g) => g.principalType === 'member').map((g) => g.principalId)),
    ];
    const groupIds = [
      ...new Set(grants.filter((g) => g.principalType === 'group').map((g) => g.principalId)),
    ];
    const emailByUser = memberIds.length
      ? await lookupEmailsByUserIds(memberIds)
      : new Map<string, string>();
    const groupNameById = new Map<string, string>();
    if (groupIds.length) {
      const groupRows = await db
        .select({ groupId: accountGroups.groupId, name: accountGroups.name })
        .from(accountGroups)
        .where(
          and(
            eq(accountGroups.accountId, loaded.row.accountId),
            inArray(accountGroups.groupId, groupIds),
          ),
        );
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
            ? (emailByUser.get(g.principalId) ?? g.principalId)
            : (groupNameById.get(g.principalId) ?? g.principalId),
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

// POST /v1/workspaces/:workspaceId/resource-grants
// Create/update a grant (idempotent on resource+principal). Validates the
// resource exists in the workspace and the principal belongs to this account.
workspaceRoutesApp.openapi(
  createRoute({
    method: 'post',
    path: '/{workspaceId}/resource-grants',
    tags: ['access'],
    summary: 'POST /:workspaceId/resource-grants',
    ...auth,
    request: {
      params: z.object({ workspaceId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: { 201: json(z.any(), 'The created grant'), ...errors(400, 404) },
  }),
  async (c: any) => {
    const workspaceId = c.req.param('workspaceId');
    const loaded = await loadWorkspaceForUser(c, workspaceId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertWorkspaceCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      workspaceId,
      WORKSPACE_ACTIONS.WORKSPACE_MEMBERS_MANAGE,
    );

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
        .where(
          and(
            eq(accountMembers.accountId, loaded.row.accountId),
            eq(accountMembers.userId, principalId),
          ),
        )
        .limit(1);
      if (!m) return c.json({ error: 'member not found in this account' }, 404);
    } else {
      const [g] = await db
        .select({ groupId: accountGroups.groupId })
        .from(accountGroups)
        .where(
          and(
            eq(accountGroups.accountId, loaded.row.accountId),
            eq(accountGroups.groupId, principalId),
          ),
        )
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
      return c.json(
        {
          error: `workspace config unavailable: ${err instanceof Error ? err.message : String(err)}`,
        },
        400,
      );
    }
    if (!workspaceHasResource(config, resourceType, resourceId)) {
      return c.json({ error: `no ${resourceType} '${resourceId}' in this workspace` }, 400);
    }

    const { grantId } = await upsertResourceGrant({
      accountId: loaded.row.accountId,
      workspaceId,
      resourceType,
      resourceId,
      principalType,
      principalId,
      grantedBy: loaded.userId,
      expiresAt: expires.value ?? null,
    });
    return c.json(
      {
        grant_id: grantId,
        resource_type: resourceType,
        resource_id: resourceId,
        principal_type: principalType,
        principal_id: principalId,
      },
      201,
    );
  },
);

// DELETE /v1/workspaces/:workspaceId/resource-grants/:grantId
workspaceRoutesApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{workspaceId}/resource-grants/{grantId}',
    tags: ['access'],
    summary: 'DELETE /:workspaceId/resource-grants/:grantId',
    ...auth,
    request: { params: z.object({ workspaceId: z.string(), grantId: z.string() }) },
    responses: { 200: json(z.any(), 'OK'), ...errors(404) },
  }),
  async (c: any) => {
    const workspaceId = c.req.param('workspaceId');
    const grantId = c.req.param('grantId');
    // grant_id is a uuid column — a malformed id is a clean 404 (same as missing),
    // not a 22P02 500.
    if (!isUuid(grantId)) return c.json({ error: 'grant not found' }, 404);
    const loaded = await loadWorkspaceForUser(c, workspaceId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertWorkspaceCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      workspaceId,
      WORKSPACE_ACTIONS.WORKSPACE_MEMBERS_MANAGE,
    );

    // The id belongs to an agent/skill grant (iam_resource_grants). Secrets no
    // longer have a resource grant to remove — secret sharing was retired.
    const removed = await deleteResourceGrant(grantId, workspaceId);
    if (!removed) return c.json({ error: 'grant not found' }, 404);
    return c.json({ ok: true });
  },
);

/**
 * Read the server-authoritative session scope.
 */
workspaceRoutesApp.openapi(
  createRoute({
    method: 'get',
    path: '/{workspaceId}/sessions/{sessionId}/scope',
    tags: ['sessions'],
    summary: "Read a session's secret and connection scope",
    ...auth,
    request: {
      params: z.object({ workspaceId: z.string(), sessionId: z.string() }),
    },
    responses: {
      200: json(SessionScopeSchema, 'Current session scope'),
      ...errors(400, 404, 409),
    },
  }),
  async (c: any) => {
    const workspaceId = c.req.param('workspaceId');
    const sessionId = c.req.param('sessionId');
    if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

    const loaded = await loadWorkspaceForUser(c, workspaceId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertWorkspaceCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      workspaceId,
      WORKSPACE_ACTIONS.WORKSPACE_SESSION_READ,
    );
    const visible = await loadVisibleSession(loaded, sessionId, callerKortixSessionId(c));
    if (!visible) return c.json({ error: 'Not found' }, 404);
    let grant: Awaited<ReturnType<typeof resolveSessionAgentGrant>>;
    try {
      grant = await resolveSessionAgentGrant({
        workspaceId,
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
      workspaceId,
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
      // `connector_bindings` above is the RESOLVED map, so an inherited session
      // and an overridden one look identical in it. Clients read this flag to
      // tell them apart — without it the browser rendered "None selected" for a
      // session that was simply inheriting, then wrote an explicit
      // zero-connector override on the next untouched save.
      connector_bindings_configured: visible.row.connectorBindingsConfigured === true,
      connector_bindings_inherit_unbound: visible.row.connectorBindingsInheritUnbound === true,
      detail: 'Current session scope.',
    });
  },
);

// GET /v1/workspaces/:workspaceId/sessions/:sessionId/config
// Is this session running the latest agent config? Compares what the BOX says
// it spawned with against what the manifest compiles to right now.
workspaceRoutesApp.openapi(
  createRoute({
    method: 'get',
    path: '/{workspaceId}/sessions/{sessionId}/config',
    tags: ['sessions'],
    summary: "Whether a session's agent config is the latest",
    ...auth,
    request: { params: z.object({ workspaceId: z.string(), sessionId: z.string() }) },
    responses: { 200: json(z.any(), 'Config freshness'), ...errors(400, 403, 404) },
  }),
  async (c: any) => {
    const workspaceId = c.req.param('workspaceId');
    const sessionId = c.req.param('sessionId');
    if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

    const loaded = await loadWorkspaceForUser(c, workspaceId, 'session');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    // `loadWorkspaceForUser(..., 'session')` is the coarse access level, not a
    // read grant. Without this an agent-scoped or read-restricted token could
    // read a session's commit sha and config hash — small, but it is session
    // state, and every other session READ on this router asserts the same leaf.
    await assertWorkspaceCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      workspaceId,
      WORKSPACE_ACTIONS.WORKSPACE_SESSION_READ,
    );
    const visible = await loadVisibleSession(loaded, sessionId, callerKortixSessionId(c));
    if (!visible) return c.json({ error: 'Not found' }, 404);

    const baseRef = visible.row.baseRef ?? loaded.row.defaultBranch;
    const [running, latest] = await Promise.all([
      readSandboxConfigState({ sessionId }),
      latestAgentConfigEtag({
        workspaceId,
        accountId: loaded.row.accountId,
        sessionId,
        baseRef,
      }),
    ]);
    return c.json({
      base_ref: baseRef,
      running_etag: running.etag,
      latest_etag: latest,
      commit_sha: running.commitSha,
      // `null` when it cannot be told — an unreachable box or a project with no
      // compiled config. Never `false`, which would read as "up to date" when
      // the truth is "did not ask".
      stale: isConfigStale(running.etag, latest),
      sandbox_reachable: running.reachable,
    });
  },
);

// POST /v1/workspaces/:workspaceId/sessions/:sessionId/reload
// Pull the workspace and recompile the agent config into a RUNNING session.
workspaceRoutesApp.openapi(
  createRoute({
    method: 'post',
    path: '/{workspaceId}/sessions/{sessionId}/reload',
    tags: ['sessions'],
    summary: "Reload a running session's agent config from git",
    ...auth,
    request: {
      params: z.object({ workspaceId: z.string(), sessionId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } }, required: false },
    },
    responses: { 200: json(z.any(), 'Reload result'), ...errors(400, 403, 404, 409) },
  }),
  async (c: any) => {
    const workspaceId = c.req.param('workspaceId');
    const sessionId = c.req.param('sessionId');
    if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

    const loaded = await loadWorkspaceForUser(c, workspaceId, 'session');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertWorkspaceCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      workspaceId,
      WORKSPACE_ACTIONS.WORKSPACE_SESSION_STOP,
    );
    assertAgentScope(c, WORKSPACE_ACTIONS.WORKSPACE_SESSION_STOP);
    const visible = await loadVisibleSession(loaded, sessionId, callerKortixSessionId(c));
    if (!visible) return c.json({ error: 'Not found' }, 404);
    // Same gate as re-scoping and changing the model: seeing a session is not
    // permission to restart the runtime underneath someone else's work.
    if (!mayChangeSessionModel(visible)) {
      return c.json(
        { error: 'Only the session owner or a workspace manager can reload this session' },
        403,
      );
    }

    const body = (await readBody(c)) as { refresh_repo?: unknown; force?: unknown };

    const result = await reloadSessionConfig({
      workspaceId,
      accountId: loaded.row.accountId,
      sessionId,
      repoUrl: loaded.row.repoUrl,
      defaultBranch: loaded.row.defaultBranch,
      manifestPath: loaded.row.manifestPath,
      baseRef: visible.row.baseRef ?? loaded.row.defaultBranch,
      refreshRepo: body?.refresh_repo !== false,
      force: body?.force === true,
    });
    // A reload restarts opencode, which ENDS the turn in flight. Refused by
    // default rather than discarding someone's work without saying so.
    if (
      result.reason === 'session is mid-turn' ||
      result.reason === 'could not confirm the session is idle'
    ) {
      return c.json(
        {
          ...result,
          error:
            result.reason === 'session is mid-turn'
              ? 'This session is mid-turn. A reload restarts the runtime and ends it — retry when idle, or pass force: true.'
              : 'Could not confirm this session is idle, and a reload restarts the runtime. Retry, or pass force: true.',
          code: 'SESSION_BUSY',
        },
        409,
      );
    }
    return c.json({
      ...result,
      detail: reloadDetail(result),
    });
  },
);

// POST /v1/workspaces/:workspaceId/sessions/:sessionId/reload-stream
// Same reload as POST /reload. This sibling route preserves the JSON contract
// used by the CLI while letting web clients render real operation phases.
workspaceRoutesApp.openapi(
  createRoute({
    method: 'post',
    path: '/{workspaceId}/sessions/{sessionId}/reload-stream',
    tags: ['sessions'],
    summary: "Reload a running session's agent config with live progress",
    ...auth,
    request: {
      params: z.object({ workspaceId: z.string(), sessionId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } }, required: false },
    },
    responses: {
      200: {
        description: 'A text/event-stream ending in one done or error frame',
        content: { 'text/event-stream': { schema: z.any() } },
      },
      ...errors(400, 403, 404),
    },
  }),
  async (c: any) => {
    const workspaceId = c.req.param('workspaceId');
    const sessionId = c.req.param('sessionId');
    if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

    const loaded = await loadWorkspaceForUser(c, workspaceId, 'session');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertWorkspaceCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      workspaceId,
      WORKSPACE_ACTIONS.WORKSPACE_SESSION_STOP,
    );
    assertAgentScope(c, WORKSPACE_ACTIONS.WORKSPACE_SESSION_STOP);
    const visible = await loadVisibleSession(loaded, sessionId, callerKortixSessionId(c));
    if (!visible) return c.json({ error: 'Not found' }, 404);
    if (!mayChangeSessionModel(visible)) {
      return c.json(
        { error: 'Only the session owner or a workspace manager can reload this session' },
        403,
      );
    }

    const body = (await readBody(c)) as { refresh_repo?: unknown; force?: unknown };

    return new Response(
      new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          let readable = true;
          const write = (data: unknown) => {
            if (!readable) return;
            try {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
            } catch {
              readable = false;
            }
          };

          try {
            const result = await reloadSessionConfig({
              workspaceId,
              accountId: loaded.row.accountId,
              sessionId,
              repoUrl: loaded.row.repoUrl,
              defaultBranch: loaded.row.defaultBranch,
              manifestPath: loaded.row.manifestPath,
              baseRef: visible.row.baseRef ?? loaded.row.defaultBranch,
              refreshRepo: body?.refresh_repo !== false,
              force: body?.force === true,
              onPhase: (phase) => write({ type: 'phase', phase }),
            });

            if (
              result.reason === 'session is mid-turn' ||
              result.reason === 'could not confirm the session is idle'
            ) {
              write({
                type: 'error',
                error:
                  result.reason === 'session is mid-turn'
                    ? 'This session is mid-turn. A reload restarts the runtime and ends it — retry when idle, or pass force: true.'
                    : 'Could not confirm this session is idle, and a reload restarts the runtime. Retry, or pass force: true.',
                code: 'SESSION_BUSY',
                status: 409,
                reason: result.reason,
              });
            } else {
              write({ type: 'done', result: { ...result, detail: reloadDetail(result) } });
            }
          } catch (error) {
            write({
              type: 'error',
              error: error instanceof Error && error.message ? error.message : 'Reload failed',
            });
          } finally {
            if (readable) {
              try {
                controller.close();
              } catch {}
            }
          }
        },
      }),
      {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      },
    ) as any;
  },
);

workspaceRoutesApp.openapi(
  createRoute({
    method: 'put',
    path: '/{workspaceId}/sessions/{sessionId}/scope',
    tags: ['sessions'],
    summary: "Re-scope a running session's secrets and connector bindings",
    ...auth,
    request: {
      params: z.object({ workspaceId: z.string(), sessionId: z.string() }),
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
    const workspaceId = c.req.param('workspaceId');
    const sessionId = c.req.param('sessionId');
    if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

    const loaded = await loadWorkspaceForUser(c, workspaceId, 'session');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertWorkspaceCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      workspaceId,
      WORKSPACE_ACTIONS.WORKSPACE_SESSION_STOP,
    );
    assertAgentScope(c, WORKSPACE_ACTIONS.WORKSPACE_SESSION_STOP);
    const visible = await loadVisibleSession(loaded, sessionId, callerKortixSessionId(c));
    if (!visible) return c.json({ error: 'Not found' }, 404);
    // Seeing a session is not permission to re-scope it — same gate as the model
    // change, for the same reason.
    if (!mayChangeSessionModel(visible)) {
      return c.json(
        { error: 'Only the session owner or a workspace manager can re-scope this session' },
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
    // `null` CLEARS the override: drop the stored rows AND the configured flag,
    // so every granted alias resolves to the workspace default again. `{}` is the
    // opposite — an explicit "no connectors at all". Before this existed an
    // override was one-way: nothing in the API could undo one.
    const clearsBindings = wantsBindings && body.connector_bindings === null;
    const wantsRequired = Object.hasOwn(body, 'require_connectors');

    // The agent grant is the ceiling for both axes. Resolved from the agent this
    // session actually runs, and fail-closed: if it cannot be established, the
    // re-scope is refused rather than applied against an unverified ceiling.
    let grant: Awaited<ReturnType<typeof resolveSessionAgentGrant>>;
    try {
      grant = await resolveSessionAgentGrant({
        workspaceId,
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
            connectionId: projectSessionConnectorBindings.connectionId,
          })
          .from(projectSessionConnectorBindings)
          .where(
            and(
              eq(projectSessionConnectorBindings.sessionId, sessionId),
              eq(projectSessionConnectorBindings.workspaceId, workspaceId),
            ),
          )
      ).map((row) => [row.alias, row.connectionId]),
    );
    const currentEffectiveBindings = await resolveEffectiveSessionConnectorBindings({
      accountId: loaded.row.accountId,
      workspaceId,
      sessionId,
      grantedConnectors: grant?.connectors,
    });
    const currentEffectiveBindingIds = Object.fromEntries(
      Object.entries(currentEffectiveBindings).map(([alias, binding]) => [
        alias,
        binding.connection_id,
      ]),
    );

    let nextAllowlist = visible.row.secretsAllowlist ?? null;
    let droppedSecrets: string[] = [];
    let addedSecrets: string[] = [];
    // Distinct from `droppedSecrets.length > 0`: a session's allowlist starts
    // null ("everything the grant allows"), so its FIRST narrowing may shrink
    // the effective set without being able to name what it lost — which is
    // precisely when the warning matters most.
    let narrowedSecrets = false;
    let canReadSecretNames = false;
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
      narrowedSecrets = decided.narrowed;
      // Only affects whether the dropped NAMES are echoed back — never whether
      // the narrowing itself is reported.
      canReadSecretNames = await workspaceCapabilityAllowed(
        c,
        loaded.userId,
        loaded.row.accountId,
        workspaceId,
        WORKSPACE_ACTIONS.WORKSPACE_SECRET_READ,
      );
      if (nextAllowlist !== null && nextAllowlist.length > 0) {
        // The SESSION OWNER, not the caller. Delivery resolves per principal —
        // `resolveOwnerRawEnv` keys the per-prompt push on `createdBy`, and
        // sessions.ts spells out why: "a per-user secret override resolves per
        // principal… if a manager restarted another member's session we'd inject
        // the MANAGER's personal secret".
        //
        // Validating against the caller let a workspace manager re-scoping someone
        // else's session add an identifier that exists only as the MANAGER's own
        // personal override. The API answered 200 with it listed in
        // `secrets_allowlist` and "Applies from the next prompt." — and the
        // session never received it, on that prompt or any later one, with
        // nothing anywhere saying so.
        //
        // Falls back to the caller only when the row carries no creator, which
        // matches how every other principal-resolution site degrades.
        const secretsPrincipal = visible.row.createdBy ?? loaded.userId;
        const availableSecrets = await listResolvedWorkspaceSecrets(workspaceId, secretsPrincipal);
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
    if (clearsBindings) {
      // No grant check and no binding validation: removing every stored binding
      // cannot widen what this session may reach beyond the workspace default,
      // which is what an un-overridden session already resolves to.
      nextBindings = {};
    } else if (wantsBindings) {
      const requested = Object.fromEntries(
        Object.entries(body.connector_bindings ?? {}).map(([alias, value]) => [
          alias,
          value.connection_id,
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
    // bindings, which must carry a connection id. So it is checked against the
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
      workspaceId: string;
      accountId: string;
      connectorAlias: string;
      connectorId: string;
      connectionId: string;
      source: 'request';
      createdBy: string;
    }> = [];
    if (wantsBindings && !clearsBindings) {
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
        workspaceId,
        actingUserId: visible.row.createdBy ?? '',
        actingPrincipalIsServiceAccount: ownerServiceAccount !== undefined,
        mayManageSystemConnections: false,
        bindings: Object.fromEntries(
          Object.entries(nextBindings).map(([alias, authorizationId]) => [
            alias,
            { connection_id: authorizationId },
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
            code: 'PERSONAL_CONNECTOR_CONNECTION_REQUIRES_PRIVATE_SESSION',
          },
          409,
        );
      }
      bindingRows = validated.bindings.map((binding) => ({
        sessionId,
        workspaceId,
        accountId: loaded.row.accountId,
        connectorAlias: binding.alias,
        connectorId: binding.connectorId,
        connectionId: binding.connectionId,
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
        // `null` reverts the session to inheriting workspace defaults; anything
        // else is an explicit override.
        sessionUpdates.connectorBindingsConfigured = !clearsBindings;
        // Deliberately NOT touching connectorBindingsInheritUnbound. Forcing it
        // false here meant a single scope save silently cut off project-default
        // fallback for every alias the caller did not re-bind — a session that had
        // been resolving Gmail from the workspace default simply stopped, with
        // nothing in the request having asked for that. The schema comment still
        // called the flag immutable while this line mutated it.
      }
      await tx
        .update(projectSessions)
        .set(sessionUpdates)
        .where(
          and(
            eq(projectSessions.sessionId, sessionId),
            eq(projectSessions.workspaceId, workspaceId),
            eq(projectSessions.accountId, loaded.row.accountId),
          ),
        );
      if (wantsBindings) {
        await tx
          .delete(projectSessionConnectorBindings)
          .where(
            and(
              eq(projectSessionConnectorBindings.sessionId, sessionId),
              eq(projectSessionConnectorBindings.workspaceId, workspaceId),
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
      workspaceId,
      sessionId,
      grantedConnectors: grant?.connectors,
    });
    if (wantsBindings) {
      droppedBindings = Object.keys(currentEffectiveBindings).filter(
        (alias) => !Object.hasOwn(effectiveBindings, alias),
      );
    }

    // Connector bindings are resolved server-side at call time, so they need no
    // push. Secrets are different: the allowlist narrows what the sandbox
    // receives, and for a long time this route just persisted the row and told
    // the caller "Applies from the next prompt." — delegating delivery to the
    // per-prompt hot sync. That delegation was unreliable. The hot sync has
    // silent early-returns (`!serviceKey`, `!snapshot`), only fires when the
    // prompt routes through `POST :8000 /session/{id}/{prompt_async|message}`
    // (a prompt sent any other way slips past it), and even when it fired the
    // daemon took the ~51ms dispose fast path for a pure secret change — and a
    // dispose re-reads the opencode config file only, NOT the child's process
    // env, so opencode kept its stale 0/47 PID while `agent-env.sh` got the new
    // set. The box reported a stale OpenCode until something else forced a
    // respawn.
    //
    // Push here, the same pattern the `/model` PUT uses: re-derive the snapshot
    // from the row we just committed, POST it to the daemon, and restart
    // opencode so `spawnChild` re-runs `mergeWorkspaceEnv` + the gateway strip.
    // Only when the effective set actually moved — a no-op re-scope (same
    // allowlist) must not restart opencode and kill an in-flight turn for
    // nothing. `applied_live` tells the caller whether it is in effect NOW or
    // only at the next boot, exactly like the model route.
    let scopeAppliedLive = false;
    let scopePushFailed = false;
    let scopePushReason: string | undefined;
    const scopeSecretsChanged =
      wantsSecrets && (narrowedSecrets || addedSecrets.length > 0 || droppedSecrets.length > 0);
    if (scopeSecretsChanged) {
      const push = await pushSessionScopeToSandbox({ workspaceId, sessionId });
      scopeAppliedLive = push.applied;
      if (!push.applied) {
        scopePushFailed = true;
        scopePushReason = push.reason;
      }
    }

    return c.json({
      secrets_allowlist: nextAllowlist,
      required_connectors: nextRequired,
      connector_bindings: effectiveBindings,
      // Names are gated; the WARNING is not. Enumerating the agent grant to
      // report what a null → list narrowing dropped hands the caller secret
      // identifiers they may not be entitled to see: this route gates on
      // project.session.stop, and a plain member holds that for their own
      // session while deliberately lacking project.secret.read. `narrowed`
      // carries no names, so the "rotate them" warning still fires for everyone
      // — which is the part that actually matters.
      dropped_secrets: canReadSecretNames ? droppedSecrets : [],
      added_secrets: addedSecrets,
      dropped_bindings: droppedBindings,
      // Echoed so the caller can re-render from THIS response instead of
      // re-fetching the scope to learn whether an override now exists.
      connector_bindings_configured: wantsBindings
        ? !clearsBindings
        : visible.row.connectorBindingsConfigured === true,
      connector_bindings_inherit_unbound: visible.row.connectorBindingsInheritUnbound === true,
      // Connector bindings ARE retroactive (resolved at call time). Secrets are
      // not: a dropped one stops being delivered from the next prompt, but the
      // agent's context and any shell it already spawned still hold what it read.
      // Keyed on `narrowed`, not on the dropped NAMES. Narrowing a session away
      // from an unrestricted allowlist shrinks what it may read even when the
      // agent's grant is 'all' and the lost names cannot be enumerated — and
      // that is the largest narrowing there is. Keying off the names suppressed
      // this warning on exactly that case, telling a user revoking every secret
      // from a live session that nothing had been dropped.
      retroactive: !narrowedSecrets,
      applied_live: scopeAppliedLive,
      ...(scopePushFailed ? { push_failed: true as const, push_reason: scopePushReason } : {}),
      detail: scopeSecretsChanged
        ? narrowedSecrets
          ? scopeAppliedLive
            ? 'Dropped secrets are cleared from the running sandbox now; new shells and the OpenCode process no longer see them. Values the agent already read remain in its context and in shells it already started — rotate them if that matters.'
            : 'Dropped secrets stop being delivered from the next prompt. Values the agent already read remain in its context and in shells it already started — rotate them if that matters.'
          : scopeAppliedLive
            ? 'Applied to the running sandbox now — the OpenCode process and new shells see the new scope.'
            : 'Applies from the next prompt.'
        : clearsBindings
          ? 'Connector access is back to the workspace defaults.'
          : 'No change to the secrets scope.',
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
workspaceRoutesApp.openapi(
  createRoute({
    method: 'put',
    path: '/{workspaceId}/sessions/{sessionId}/model',
    tags: ['sessions'],
    summary: "Change a running session's model",
    ...auth,
    request: {
      params: z.object({ workspaceId: z.string(), sessionId: z.string() }),
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
    const workspaceId = c.req.param('workspaceId');
    const sessionId = c.req.param('sessionId');
    if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

    const loaded = await loadWorkspaceForUser(c, workspaceId, 'session');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    // A live model change restarts opencode and can terminate the target
    // session's in-flight turn. Scoped agent tokens therefore need the same
    // destructive capability as the stop route (no-op for human/PAT tokens).
    assertAgentScope(c, WORKSPACE_ACTIONS.WORKSPACE_SESSION_STOP);
    const visible = await loadVisibleSession(loaded, sessionId, c.get('sessionId') ?? null);
    if (!visible) return c.json({ error: 'Not found' }, 404);
    // Seeing a session is not permission to mutate it: visibility 'project'
    // makes it readable by every member, but changing the model restarts
    // opencode and destroys the OWNER's in-flight turn. Same gate as the
    // sharing and stop routes above.
    if (!mayChangeSessionModel(visible)) {
      return c.json(
        { error: 'Only the session owner or a workspace manager can change this session model' },
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
    const freeModelsOnly = !(await accountMayUseManagedModels(loaded.row.accountId));
    const servable = await isModelServableForAccount({
      userId: loaded.userId,
      accountId: loaded.row.accountId,
      workspaceId,
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

    const push = await pushSessionModelToSandbox({ workspaceId, sessionId, model: nextModel });
    return c.json(modelChangeResult({ model: nextModel, needsPush: true, push }));
  },
);
