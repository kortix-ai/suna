/**
 * Project session lifecycle: create, list, read, sharing, patch, soft delete and restore.
 * Invariant: session_id == sandbox_id == git branch name.
 */

import {
  SESSION_SHARING_OWNER_ONLY_ERROR,
  SHARING_SELF_LOCKOUT_ERROR,
  parseSharingIntent,
  sessionIntentToVisibility,
  setSessionSharing,
  sharingChangeKeepsEditorAccess,
} from '../../connectors/share';
import { PROJECT_ACTIONS } from '../../iam';
import { assertAgentScope, isProjectSessionPrincipal } from '../../iam/agent-scope';
import { isAgentPrincipalActor } from '../../iam/actor';
import { supabaseAuth } from '../../middleware/auth';
import { auth, errors, json, lenientBody } from '../../openapi';
import { db } from '../../shared/db';
import type { AppEnv } from '../../types';

import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { projectSessions } from '@kortix/db';
import { SessionUpdateInputSchema } from '@kortix/api-contract';
import { and, eq, sql } from 'drizzle-orm';
import { callerHasManagerStanding, loadProjectForUser, loadVisibleSession, resolveSessionOwnerIdentities, assertProjectCapability, projectCapabilityAllowed, sessionIsTombstoned, sessionProjectId } from '../lib/access';
import { OkSchema, SessionCreateAcceptedSchema, SessionCreateInputSchema, SessionDeleteResultSchema, SessionSchema, projectsApp, sessionsApp } from '../lib/app';
import {
  hasOwn,
  normalizeString,
  requestAuditContext,
  serializeSession,
} from '../lib/serializers';
import { isUuid } from '../../shared/validate';
import { readJsonObject } from '../../shared/http-body';
import { projectSessionMetadataMerge } from '../lib/session-metadata-merge';
import { resolveAndAuthorizeAgent } from '../lib/agent-access';
import { SESSION_CREATE_ERROR_STATUSES, sendSessionCreateError } from '../lib/sessions';
import { sessionHasPersonalConnectorBinding } from '../lib/session-connector-bindings';
import { sessionPersonOnlyPlaintextSecrets } from '../lib/secret-audience';
import { notifySessionShared } from '../lib/notification-recipients';
import { notificationsEnabled } from '../../notifications/enabled';
import { createSession, deleteSession, restoreSession } from '../session-lifecycle';
import { sessionRestoreUntil } from '../session-log-purge';
import { readSessionConversationModels } from '../session-log-read';
import { validateProviderSecretPool } from './provider-secret-pools';
import { requireFeatureFlag } from '../../feature-flags/gate';
import { resolveFeatureFlag } from '../../feature-flags/registry';
import { accountMayUseManagedModels } from '../../billing/services/entitlements';
import { DEFAULT_AGENT_SENTINEL } from '../agents';
import { admitSessionSharingChange } from '../lib/session-model-keys';
import { projectLlmGatewayEnabled } from '../../llm-gateway/enablement';
import { callerKortixSessionId } from '../../middleware/caller-session';
import { getImpersonationContext } from '../../shared/impersonation';
import { peekSessionListPollEtag, storeSessionListPollEtag } from '../lib/session-list-poll-memo';
import type { ProjectSessionListScope } from '../lib/session-inventory';
import { loadProjectSessionInventory, sessionRowMatchesSearch } from '../lib/session-list';
import { SESSION_PAGE_MAX_LIMIT } from '../lib/session-inventory';
import {
  PATCH_SERVER_MANAGED_SESSION_METADATA_KEYS,
  SERVER_MANAGED_SESSION_METADATA_KEYS,
} from '../lib/session-metadata-keys';
import { loadSessionUserStates } from '../lib/session-user-state';
import { personUserId } from './session-watch';
import { sessionCreateSurface } from '../lib/session-surface';

const NO_USER_STATE = { pinnedAt: null, archivedAt: null };

function serverManagedSessionMetadataKey(
  value: unknown,
  keys: readonly string[] = SERVER_MANAGED_SESSION_METADATA_KEYS,
): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const metadata = value as Record<string, unknown>;
  return keys.find((key) => hasOwn(metadata, key)) ?? null;
}

/**
 * One session read by id: the body and the access check of
 * `GET /v1/projects/:projectId/sessions/:sessionId`. The account-scoped
 * `GET /v1/sessions/:sessionId` answers through it too, so the two routes
 * cannot disagree on who may read a session.
 */
async function sessionReadResponse(c: Context<AppEnv>, projectId: string, sessionId: string) {
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
  if (sessionIsTombstoned(visible.row)) return c.json({ error: 'Not found' }, 404);
  // The same owner resolution the list uses: without it a read-by-id reported
  // owner_type 'unknown' and no owner name for the very session the list named.
  const personId = personUserId(c, loaded);
  const [owners, userStates, conversationModels] = await Promise.all([
    visible.row.createdBy
      ? resolveSessionOwnerIdentities([visible.row.createdBy], loaded.row.accountId)
      : undefined,
    personId ? loadSessionUserStates([sessionId], personId) : undefined,
    readSessionConversationModels([sessionId]),
  ]);
  const owner = visible.row.createdBy ? owners?.get(visible.row.createdBy) : undefined;
  return c.json(serializeSession(visible.row, {
    grants: visible.grants,
    conversationModel: conversationModels.get(sessionId),
    viewerId: loaded.userId,
    canManageProject: visible.canManageProject,
    ownerIsMachine: visible.ownerIsMachine,
    ownerEmail: owner?.email ?? null,
    ownerName: owner?.name ?? null,
    ownerAvatarUrl: owner?.avatarUrl ?? null,
    ownerType: owner?.type ?? (visible.row.createdBy ? 'unknown' : null),
    userState: personId ? (userStates?.get(sessionId) ?? NO_USER_STATE) : undefined,
  }), 200);
}

/**
 * `GET /v1/sessions/:sessionId`: one session by id, in whichever project holds
 * it. A client that has only the id (an SDK `restartSandbox(id)`) reads it here
 * instead of listing every project's sessions (KRTX-2316). The answer is the
 * project route's own (`sessionReadResponse`), with one difference: the
 * project gate's `403` (no member of the account, no access to the project, no
 * session read) is `404` here. The id alone must not tell a caller that a
 * session exists, so an unknown id, a session the caller may not see and a
 * deleted one are all `404`. A project-scoped token is refused before this
 * handler (`enforceTokenProjectScope`: no project in the path).
 */
export function registerSessionLookupRoutes(): void {
  sessionsApp.use('/*', supabaseAuth);

  sessionsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{sessionId}',
      tags: ['sessions'],
      summary: 'Get a session by id, in any project',
      ...auth,
      request: {
        params: z.object({ sessionId: z.string() }),
      },
      responses: {
        200: json(SessionSchema, 'The session. `project_id` names its project.'),
        ...errors(400, 403, 404),
      },
    }),
    async (c) => {
      const sessionId = c.req.param('sessionId');
      if (!isUuid(sessionId)) return c.json({ error: 'Invalid session id' }, 400);
      const projectId = await sessionProjectId(sessionId);
      if (!projectId) return c.json({ error: 'Not found' }, 404);
      try {
        return await sessionReadResponse(c, projectId, sessionId);
      } catch (error) {
        if (error instanceof HTTPException && error.status === 403) return c.json({ error: 'Not found' }, 404);
        throw error;
      }
    },
  );
}

export function registerProjectSessionsRoutes(): void {
  // Session routes. Invariant: session_id == sandbox_id == git branch name.

  // POST /v1/projects/:projectId/sessions

  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{projectId}/sessions',
      tags: ['sessions'],
      summary: 'Create a session (start an agent task)',
      ...auth,
        request: {
          params: z.object({ projectId: z.string() }),
          body: { content: { 'application/json': { schema: SessionCreateInputSchema } } },
        },
      responses: {
          201: json(SessionSchema, 'The created session'),
          202: json(SessionCreateAcceptedSchema, 'Create accepted; poll the session'),
          ...errors(...SESSION_CREATE_ERROR_STATUSES),
      },
    }),
    async (c) => {
    const projectId = c.req.param('projectId');
    const body = await readJsonObject(c);
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
    if (body.provider_secret_pools !== undefined) {
      const gate = requireFeatureFlag(c, loaded.row.metadata, 'pooled_provider_secrets');
      if (gate) return gate;
      if (!projectLlmGatewayEnabled(loaded.row.metadata)) {
        return c.json({ error: 'Provider pools require the LLM gateway' }, 409);
      }
      for (const [providerId, ids] of Object.entries(body.provider_secret_pools as Record<string, string[]>)) {
        const invalid = await validateProviderSecretPool({
          accountId: loaded.row.accountId, projectId, repoUrl: loaded.row.repoUrl,
          defaultBranch: loaded.row.defaultBranch, manifestPath: loaded.row.manifestPath,
          agentName: normalizeString(body.agent_name) ?? agentAccess.agentName ?? 'default', userId: loaded.userId,
          providerId, ids,
        });
        if (invalid) return c.json({ error: invalid.error }, invalid.status);
      }
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
      // The surface it came through: ui, cli or mobile (KRTX-2914).
      source: sessionCreateSurface(c.req.header('x-kortix-client-version')),
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
        canManageProject: await callerHasManagerStanding(loaded, callerKortixSessionId(c)),
      }),
      201,
    );
  },
  // The KaaB contract (apps/web/content/docs/sdk/sessions.mdx) promises coded
  // 400s for the three structured create fields. Schema validation runs before
  // the handler, so without this hook zod failures collapse into the generic
  // defaultHook envelope and the documented codes never reach HTTP callers.
  (result, c) => {
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
      summary: 'List sessions of a project',
      ...auth,
        request: {
          params: z.object({ projectId: z.string() }),
          query: z.object({
            scope: z.enum(['visible', 'project']).optional(),
            // The list is a keyset PAGE, not the whole inventory. See
            // `lib/session-inventory.ts` for why, and `X-Next-Cursor` below for
            // how a caller walks it.
            limit: z.coerce.number().int().min(1).max(SESSION_PAGE_MAX_LIMIT).optional(),
            cursor: z.string().optional(),
            // `root` = top-level sessions only (each row carries `child_count`);
            // a session id = that session's children. Absent = the flat list.
            parent: z.string().min(1).max(128).optional(),
            started_by: z.enum(['me', 'others', 'automated']).optional(),
            // Server-side search over every session the viewer may see.
            q: z.string().trim().min(1).max(200).optional(),
            // Repeatable; a session must carry every given label. Exact match.
            label: z
              .union([z.string().min(1).max(64), z.array(z.string().min(1).max(64)).max(20)])
              .optional(),
            // The requesting person's pinned or archived sessions only. Without
            // either, the list leaves out the sessions the person archived.
            pinned: z.literal('only').optional(),
            archived: z.literal('only').optional(),
            // Recently deleted (KRTX-2853): the deleted sessions the caller may
            // restore (its owner or a project manager), inside their window,
            // each with `restore_until`. Combines with no other view.
            deleted: z.literal('only').optional(),
          }),
        },
      responses: {
          200: json(z.array(SessionSchema), 'Sessions'),
          // The list is polled; a repeat with a matching If-None-Match ends here
          // with no body. Declared so the OpenAPI contract matches what ships.
          304: { description: 'Not modified — the ETag still matches' },
          ...errors(400, 403, 404),
      },
    }),
    async (c) => {
    const projectId = c.req.param('projectId');
    const query = c.req.valid('query');
    const scope = (query.scope ?? 'visible') as ProjectSessionListScope;

    // The poll memo: an If-None-Match repeat of the same (viewer, query) within
    // the short window is a 304 with no DB work at all. The ETag below is only
    // known after the full multi-op inventory, so without this every poll paid
    // 6-14 connection-pool round trips to learn the page was unchanged — and a
    // poll burst queued its own operations into the p95 (KRTX-468). The key is
    // built entirely from values the auth middleware already resolved, before
    // any DB read; the first successful response seeds it, so a burst pays
    // once and every repeat within the window is free.
    const pollMemoKey = [
      c.get('userId'),
      c.get('iamTokenId'),
      c.get('authType'),
      callerKortixSessionId(c),
      // Act-as widens what the same user sees (every session, via oversight).
      getImpersonationContext()?.grantId ?? '',
      projectId,
      c.req.url.split('?')[1] ?? '',
    ].join('|');
    // KRTX-2736: build the poll response with its headers AT construction and
    // never touch the context response afterwards. `c.header()` on a finalized
    // context re-wraps the existing response's body through
    // `createResponseInstance` (`new Response(res.body, res)`), and if
    // something finalized the context mid-handler with a ReadableStream body
    // that had already been locked and read, that re-wrap throws
    // `TypeError: Body object should not be disturbed or locked` — the
    // unattributed 500s prod logged on this route on 2026-10-17. Passing the
    // headers into `c.body` embeds them without a re-wrap. And when the
    // context WAS finalized behind us, our response must still win: compose
    // skips assignment once `finalized` is true, so assign through `c.res` —
    // its re-wrap wraps OUR OWN string/null body, which is always safe.
    const claim = (response: Response): Response => {
      if (c.finalized) c.res = response;
      return response;
    };
    const ifNoneMatch = c.req.header('if-none-match');
    if (ifNoneMatch) {
      const memoed = peekSessionListPollEtag(pollMemoKey, ifNoneMatch);
      if (memoed) {
        // Same binding `loadProjectForUser` performs on the computed path;
        // a browser-JWT principal has no other source for it, and the audit
        // snapshot and the post-handler context propagation both read it.
        c.set('accountId', memoed.accountId);
        const memoHeaders: Record<string, string> = {
          'Cache-Control': 'private, no-cache',
          ETag: memoed.etag,
          'Access-Control-Expose-Headers': 'X-Next-Cursor',
        };
        if (memoed.nextCursor) memoHeaders['X-Next-Cursor'] = memoed.nextCursor;
        return claim(c.body(null, 304, memoHeaders));
      }
    }

    if (query.pinned && query.archived) {
      return c.json({ error: 'Choose pinned=only or archived=only, not both' }, 400);
    }
    if (query.deleted && (query.pinned || query.archived)) {
      return c.json({ error: 'deleted=only does not combine with pinned=only or archived=only' }, 400);
    }
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_SESSION_READ);
    const personId = personUserId(c, loaded);

    const inventory = await loadProjectSessionInventory({
      projectId,
      accountId: loaded.row.accountId,
      userId: loaded.userId,
      scope,
      orderByActivity: loaded.row.metadata?.session_list_order === 'activity',
      limit: query.limit,
      cursor: query.cursor ?? null,
      filter: {
        parent: query.parent ?? null,
        startedBy: query.started_by ?? null,
        q: query.q ?? null,
        labels: query.label === undefined ? null : [query.label].flat(),
        personId,
        view: query.pinned ? 'pinned' : query.archived ? 'archived' : null,
        deleted: query.deleted === 'only',
      },
      boundCredentialSessionId: callerKortixSessionId(c),
      agentPrincipal: loaded.actor ? isAgentPrincipalActor(loaded.actor) : false,
      probeManageCapability: () =>
        projectCapabilityAllowed(
          c,
          loaded.userId,
          loaded.row.accountId,
          projectId,
          'project.members.manage',
        ),
    });
    if (!inventory.authorized) {
      return c.json({ error: 'Project manager access is required to list every session' }, 403);
    }

    const conversationModels = await readSessionConversationModels(
      inventory.items.filter((item) => item.canAccess).map((item) => item.row.sessionId),
    );
    const body = inventory.items.map((item) => {
      const row = item.row;
      const owner = row.createdBy ? inventory.ownerIdentities.get(row.createdBy) : null;
      const serialized = serializeSession(row, {
        initiatorName: row.initiatorId ? (inventory.initiatorNames.get(row.initiatorId) ?? null) : null,
        grants: inventory.grantsBySession.get(row.sessionId) ?? [],
        viewerId: loaded.userId,
        canManageProject: inventory.canManageProject,
        // Only a RESOLVED service account counts as machine-owned. 'unknown'
        // (a stale principal) keeps the session owner-only — fail closed.
        ownerIsMachine: !row.createdBy || owner?.type === 'service_account',
        ownerEmail: owner?.email ?? null,
        ownerName: owner?.name ?? null,
        ownerAvatarUrl: owner?.avatarUrl ?? null,
        ownerType: owner?.type ?? (row.createdBy ? 'unknown' : null),
        canAccess: item.canAccess,
        runtimeStatus: item.runtimeStatus,
        deletedAt: item.deletedAt,
        deletedBy: item.deletedBy,
        userState: personId ? (inventory.userStates.get(row.sessionId) ?? NO_USER_STATE) : undefined,
        // The inventory listing drops the write-only heavy metadata keys. The
        // single-session read below still returns metadata whole.
        trimListMetadata: true,
        conversationModel: conversationModels.get(row.sessionId),
      });
      if (query.parent !== 'root') return serialized;
      return {
        ...serialized,
        child_count: inventory.childCounts.get(row.sessionId) ?? 0,
        ...(query.q ? { search_match: sessionRowMatchesSearch(row, query.q, [owner?.email, owner?.name].filter((v): v is string => Boolean(v))) ? 'self' : 'child' } : {}),
      };
    });

    // The sidebar re-fetches this list several times per session open (six in the
    // measured SampleCo corpus, 2026-08-26) and the answer is usually byte-identical
    // between them. A weak ETag lets those repeats end as a 304 with no body.
    const serialized = JSON.stringify(body);
    // The cursor is part of the response identity: two pages of the same length
    // whose rows happen to hash alike must not 304 each other into the wrong
    // continuation. Hash it with the body.
    const etag = `W/"${Bun.hash(`${inventory.nextCursor ?? ''}:${serialized}`).toString(36)}-${body.length}"`;
    const headers: Record<string, string> = {
      // `no-cache` — not `no-store` — is what makes a client revalidate rather
      // than serve a stale inventory: the response is private and always
      // re-validated, it just does not have to be re-transferred.
      'Cache-Control': 'private, no-cache',
      ETag: etag,
      // The page's continuation token. Absent means this is the last page. It
      // rides a header so the 200 body stays the bare `Session[]` array every
      // existing client already parses — adding an envelope would have broken
      // all of them.
      'Access-Control-Expose-Headers': 'X-Next-Cursor',
    };
    if (inventory.nextCursor) headers['X-Next-Cursor'] = inventory.nextCursor;
    storeSessionListPollEtag(pollMemoKey, {
      etag,
      nextCursor: inventory.nextCursor,
      accountId: loaded.row.accountId,
    });
    if (c.req.header('if-none-match') === etag) return claim(c.body(null, 304, headers));
    return claim(c.body(serialized, 200, { ...headers, 'Content-Type': 'application/json' }));
  },
  );

  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/sessions/{sessionId}',
      tags: ['sessions'],
      summary: 'Get a session',
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
    const sessionId = c.req.param('sessionId');
    if (!isUuid(sessionId)) return c.json({ error: 'Invalid session id' }, 400);
    return sessionReadResponse(c, c.req.param('projectId'), sessionId);
  },
  );

  projectsApp.openapi(
    createRoute({
      method: 'put',
      path: '/{projectId}/sessions/{sessionId}/sharing',
      tags: ['sessions'],
      summary: 'Set who can see a session',
      ...auth,
        request: {
          params: z.object({ projectId: z.string(), sessionId: z.string() }),
          body: { content: { 'application/json': { schema: lenientBody({
              mode: z.enum(['project', 'private', 'members']).openapi({ description: 'project: everyone in the project. private: owner only. members: the listed members and groups.' }),
              ownerId: z.string().optional().openapi({ description: 'For mode private: the owner user id. Defaults to the caller.' }),
              memberIds: z.array(z.string()).optional().openapi({ description: 'For mode members: user ids.' }),
              groupIds: z.array(z.string()).optional().openapi({ description: 'For mode members: group ids.' }),
            }) } } },
        },
      responses: {
          200: json(z.any(), 'OK'),
          ...errors(400, 403, 404, 409),
      },
    }),
    async (c) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    if (!isUuid(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

    const body = await readJsonObject(c);
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
      (await sessionHasPersonalConnectorBinding({
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

    // A value shared only with this session's person sits in the sandbox as
    // plaintext; sharing the session would hand it to every new viewer, and an
    // env var cannot be taken back out of a running box (secret-audience.ts).
    if (intent.mode !== 'private') {
      const held = await sessionPersonOnlyPlaintextSecrets({
        accountId: loaded.row.accountId,
        projectId,
        sessionId,
      });
      if (held.length > 0) {
        return c.json(
          {
            error: `This session holds ${held.join(', ')}, shared only with you. Sharing it would let others read ${held.length === 1 ? 'it' : 'them'}. Start a new session to share, or share ${held.length === 1 ? 'that secret' : 'those secrets'} with everyone first.`,
            code: 'PERSONAL_SECRET_REQUIRES_PRIVATE_SESSION',
            secrets: held,
          },
          409,
        );
      }
    }

    // Sharing takes the owner's personal keys away from the session (spec
    // 2026-09-22 §2.3). A model that ran only on them switches to the keys shared
    // with the whole project, or the share is refused (lib/session-model-keys.ts).
    if (intent.mode !== 'private' && projectLlmGatewayEnabled(loaded.row.metadata)) {
      // The session model lives in metadata, not a column (routes/session-scope.ts).
      const metadata = (visible.row.metadata ?? {}) as Record<string, unknown>;
      const admitted = await admitSessionSharingChange({
        accountId: loaded.row.accountId,
        projectId,
        sessionId,
        owner: visible.row.createdBy ?? loaded.userId,
        freeModelsOnly: !(await accountMayUseManagedModels(loaded.row.accountId)),
        model: typeof metadata.opencode_model === 'string' ? metadata.opencode_model : null,
        visibility: next.visibility,
        mayPool:
          resolveFeatureFlag(loaded.row.metadata, 'pooled_provider_secrets') &&
          !visible.ownerIsMachine &&
          Boolean(visible.row.createdBy),
        callerMaySelect: async (providerId, secretIds) =>
          !(await validateProviderSecretPool({
            accountId: loaded.row.accountId,
            projectId,
            repoUrl: loaded.row.repoUrl,
            defaultBranch: loaded.row.defaultBranch,
            manifestPath: loaded.row.manifestPath,
            agentName: visible.row.agentName ?? DEFAULT_AGENT_SENTINEL,
            userId: loaded.userId,
            providerId,
            ids: secretIds,
          })),
      });
      if (!admitted.ok) {
        return c.json(
          {
            error:
              `This session runs ${admitted.model} on keys that work only in your private sessions. ` +
              'A shared session uses only keys shared with the whole project, and none can run this model. ' +
              'Share a key with the whole project, or switch the session to another model, then share the session.',
            code: 'SHARED_SESSION_NEEDS_PROJECT_KEY',
          },
          409,
        );
      }
    }

    // Others prompt a shared session, and a personal drive is its owner's alone:
    // it leaves the running sandbox first, or the session stays private.
    if (intent.mode !== 'private') {
      const { detachPersonalDrives } = await import('../../drives/service');
      if (!(await detachPersonalDrives(sessionId))) {
        return c.json(
          {
            error: 'Your personal drive could not be removed from this session. Try again in a moment.',
            code: 'PERSONAL_DRIVE_DETACH_FAILED',
          },
          409,
        );
      }
    }

    await setSessionSharing(sessionId, intent);
    // "Shared with you" for the people this change newly names (KRTX-1742),
    // only with the project's notification_center flag on. `visible.grants`
    // and `visible.row.visibility` were read BEFORE the change.
    // Fire-and-forget: it never throws and never delays or fails the share.
    if (notificationsEnabled(loaded.row.metadata)) {
      void notifySessionShared({
        accountId: loaded.row.accountId,
        projectId,
        sessionId,
        sharerId: loaded.userId,
        creatorId: visible.row.createdBy,
        priorGrants: visible.grants,
        priorVisibility: visible.row.visibility,
        intent,
      });
    }

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
      summary: 'Rename a session or merge metadata into it',
      ...auth,
        request: {
          params: z.object({ projectId: z.string(), sessionId: z.string() }),
          body: { content: { 'application/json': { schema: lenientBody({
              name: z.string().optional().openapi({ description: 'New display name. Empty string or null clears the rename.' }),
              labels: z.array(z.string()).optional().openapi({ description: 'Replaces the session labels. Each is trimmed, 1..64 characters; at most 20; duplicates drop. [] clears them.' }),
              metadata: z.record(z.string(), z.any()).optional().openapi({ description: 'Keys merged into the session metadata; a null value removes that key. Server-managed keys are rejected. At most 16,384 characters of JSON.' }),
            }) } } },
        },
      responses: {
          200: json(SessionSchema, 'The updated session'),
          ...errors(400, 404),
      },
    }),
    async (c) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    if (!isUuid(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

    const body = await readJsonObject(c);
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

    const allowedFields = ['name', 'labels', 'metadata'];
    const unknownField = Object.keys(body).find((field) => !allowedFields.includes(field));
    if (unknownField) {
      return c.json({ error: `field is not user-editable: ${unknownField}` }, 400);
    }
    const parsed = SessionUpdateInputSchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      return c.json({ error: `${issue.path.join('.') || 'body'}: ${issue.message}` }, 400);
    }

    // metadata.deletedAt / deletedBy are SERVER-MANAGED soft-delete markers.
    // deleteSession() is the only legitimate writer; they are consumed by
    // isSessionVisibleTo (session-inventory.ts — hides the session from every member's
    // list), the continue-session guard (session-lifecycle/continue-session.ts `continueSession` —
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
    const forgedKey = serverManagedSessionMetadataKey(
      body.metadata,
      PATCH_SERVER_MANAGED_SESSION_METADATA_KEYS,
    );
    if (forgedKey) {
      return c.json({ error: `metadata key is server-managed: ${forgedKey}` }, 400);
    }
    const metadata =
      body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
        ? (body.metadata as Record<string, unknown>)
        : null;

    const visible = await loadVisibleSession(loaded, sessionId, c.get('sessionId') ?? null, callerKortixSessionId(c));
    if (!visible) return c.json({ error: 'Not found' }, 404);

    const updates: Partial<typeof projectSessions.$inferInsert> = { updatedAt: new Date() };

    // A user-set name is the AUTHORITATIVE display name. It lives in
    // metadata.custom_name — a separate key from metadata.name (the server-side
    // auto title mirrored from OpenCode during session reads) so a rename is never
    // clobbered by a later sync. Passing name: "" (or null) clears the override
    // and reverts the session to its auto title.
    const hasNameField = hasOwn(body, 'name');
    const name = normalizeString(body.name);

    if (parsed.data.labels) updates.labels = parsed.data.labels;

    if (hasNameField || metadata) {
      // Merge in SQL, never write back the whole object read above: the read and
      // this UPDATE are not atomic, and the first-prompt title generator commits
      // `metadata.name` between them. A read-modify-write here would drop that
      // committed title (or another writer's keys) for a session with no later
      // prompt to re-trigger titling. `||` evaluates after the row lock.
      // A null client value removes that key (JSON merge patch). custom_name
      // keeps its explicit null: every reader already treats it as no override.
      const patch: Record<string, unknown> = {};
      const removed: string[] = [];
      for (const [key, value] of Object.entries(metadata ?? {})) {
        if (value === null) removed.push(key);
        else patch[key] = value;
      }
      if (hasNameField) patch.custom_name = name || null;
      updates.metadata = sql`(${projectSessionMetadataMerge(patch)}) - array(select jsonb_array_elements_text(${JSON.stringify(removed)}::jsonb))` as unknown as typeof updates.metadata;
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
  // Soft delete: the session goes to the trash until `restore_until`. The
  // remote branch is kept for good, so the user can still merge or recover
  // work after the window.

  projectsApp.openapi(
    createRoute({
      method: 'delete',
      path: '/{projectId}/sessions/{sessionId}',
      tags: ['sessions'],
      summary: 'Delete a session (restorable until restore_until; its branch is kept)',
      ...auth,
        request: {
          params: z.object({ projectId: z.string(), sessionId: z.string() }),
        },
      responses: {
          200: json(SessionDeleteResultSchema, 'Session deleted; restorable until restore_until'),
          ...errors(400, 403, 404),
      },
    }),
    async (c) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    if (!isUuid(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

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
    // A repeated delete (the SDK retries one whose response was lost) answers
    // with the first stamp: the restore window never moves.
    const restoreUntil = sessionIsTombstoned(visible.row) ? sessionRestoreUntil(visible.row.metadata?.deletedAt) : null;
    if (restoreUntil) return c.json({ ok: true as const, restore_until: restoreUntil.toISOString() });

    const result = await deleteSession({
      projectId,
      sessionId,
      accountId: loaded.row.accountId,
      userId: loaded.userId,
    });
    if ('error' in result) return c.json({ error: result.error }, result.status as any);
    return c.json(result);
  },
  );

  // POST /v1/projects/:projectId/sessions/:sessionId/restore
  // Take a deleted session out of the trash. Same gate as the delete. 409
  // `session_not_deleted`: nothing to restore. 409
  // `session_sandbox_removal_pending`: the old sandbox is still being removed;
  // retry. 410 `session_purged`: past `restore_until`, the content is gone.

  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{projectId}/sessions/{sessionId}/restore',
      tags: ['sessions'],
      summary: 'Restore a deleted session before its restore_until',
      ...auth,
        request: {
          params: z.object({ projectId: z.string(), sessionId: z.string() }),
        },
      responses: {
          200: json(OkSchema, 'Session restored; its next start boots a fresh sandbox from its branch'),
          ...errors(400, 403, 404, 409, 410),
      },
    }),
    async (c) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    if (!isUuid(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

    const loaded = await loadProjectForUser(c, projectId, 'session');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    assertAgentScope(c, PROJECT_ACTIONS.PROJECT_SESSION_STOP);

    const visible = await loadVisibleSession(loaded, sessionId, c.get('sessionId') ?? null, callerKortixSessionId(c));
    if (!visible) return c.json({ error: 'Not found' }, 404);
    if (!visible.canManageLifecycle) {
        return c.json(
          { error: 'Only the session owner or a project manager can restore this session' },
          403,
        );
    }

    const result = await restoreSession({ projectId, sessionId, accountId: loaded.row.accountId });
    if ('error' in result) return c.json({ error: result.error, code: result.code }, result.status);
    return c.json(result);
  },
  );
}
