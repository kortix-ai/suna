import {
  connectorConnections,
  connectorActions,
  connectorPolicies,
  connectors,
  connectorCalls,
  connectorProjectPolicies,
  connectorProjectSettings,
  projectSecrets,
  projectSessionConnectorBindings,
  projectSessions,
  projects,
  tunnelConnections,
} from '@kortix/db';
import { sanitizeConnectorHeaders, SLUG_RE } from '@kortix/manifest-schema';
import { and, desc, eq, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
/**
 * Production wiring for the connector router — DB-backed ConnectorRouterDeps +
 * GatewayDeps. Access lives on the connector; credentials are split per (connector,
 * user). The pure logic (gateway/share/execute/policy/normalize) is tested; this
 * is the glue to Postgres + the credential store + Pipedream. See docs/specs/connector.md.
 */
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { resolveAgentMailApiKey } from '../channels/agentmail-api';
import {
  loadAgentMailApiKeyForInbox,
  loadAgentMailApiKeyForProject,
  loadAgentMailInstall,
  loadSlackInstall,
  loadSlackTokenForProject,
  loadTeamsBotCredentials,
  loadTeamsInstall,
  loadTeamsTenantForProject,
} from '../channels/install-store';
import { resolveProjectBotName } from '../channels/voice-identity';
import { joinPageUrl } from '../channels/voice/livekit';
import { mintJoinLink } from '../channels/voice/join-links';
import { approvalPageUrl } from '../setup-links/token';
import { endCall, isCallLive, promptVoiceAgent, startCall } from '../channels/voice/runtime';
import { readTranscriptForAgent } from '../channels/voice/transcript-read';
import { kortixSay } from '../channels/voice/utterance';
import { config } from '../config';
import { projectFeatureFlagEnabled } from '../feature-flags/for-project';
import { authorize, PROJECT_ACTIONS } from '../iam';
import { agentMayUseConnector } from '../iam/agent-scope';
import type { ChannelPlatform } from '../projects/connectors';
import { invalidateProjectMirror } from '../projects/git';
import { loadProjectForUser } from '../projects/lib/access';
import { connectorAuthorizationMatchesStrategy } from '../projects/lib/connector-authorization-strategy';
import { reconcileStoredSessionAgentGrant } from '../projects/lib/session-token-grant';
import { getProjectSecretValueForConsumer } from '../projects/secrets';
import {
  canonicalConnectorAlias,
  publicConnectorAlias,
  resolveSessionConnectorConnection,
} from '../projects/lib/session-connector-bindings';
import { validateAccountToken } from '../repositories/account-tokens';
import { db } from '../shared/db';
import { executeComputerCall } from '../tunnel/core/rpc-core';
import { connectorAttachmentStore } from './attachments';
import { computerProfileSpec } from './computer-materialize';
import { COMPUTER_SLUG, computerLabel } from './computers';
import { hideSupersededSlack } from './channel-rules';
import { buildAdminConnectorViews } from './connector-list';
import { validateConnectorSecretBinding } from './connector-secret-binding';
import {
  connectorIdsWithSharedCredentials,
  credentialExists,
  deleteCredential,
  connectionCredentialExists,
  resolveCredentialValue,
  resolveConnectionCredentialValue,
} from './credentials';
import type { ConnectorAuth, FetchImpl } from './call';
import type { GatewayAction, GatewayConnector, GatewayDeps } from './gateway';
import {
  type ConnectorDraft,
  deleteConnectorFromManifest,
  getConnectorConfigFromManifest,
  getConnectorPoliciesFromManifest,
  getProjectPoliciesFromManifest,
  setConnectorCredentialModeInManifest,
  setConnectorAuthorizationStrategyInManifest,
  setConnectorCredentialShared,
  setConnectorNameInManifest,
  setConnectorPoliciesInManifest,
  setConnectorSensitiveInManifest,
  setProjectPoliciesInManifest,
  upsertConnectorInManifest,
} from './manifest-crud';
import { graphToken } from '../channels/teams-auth';
import {
  finalizePipedreamConnection,
  finalizePipedreamConnectionAuthorization,
  pipedreamCatalogPage,
  pipedreamCatalogSections,
  pipedreamConfigured,
  pipedreamConnectUrl,
  runPipedreamAction,
  runPipedreamProxy,
  verifyWebhookSig,
} from './pipedream';
import {
  type DefaultMode,
  type EffectiveResolveResult,
  type Policy,
  type PolicyAction,
  isValidMatcher,
  parseStoredConditions,
  resolveEffectiveAction,
  selectPoliciesForRead,
} from './policy';
import type {
  AdminConnectorView,
  CatalogConnector,
  ConnectorPrincipal,
  ConnectorRouterDeps,
} from './router';
import { resolveShareSubject } from './share';
import { getConnectorCatalogDetail, listConnectorCatalog } from './connector-catalog';
import {
  discoverDraftConnectorAuth,
  materializeComputerConnectorProfile,
  setMaterializedComputerConnectorPolicies,
  syncProjectConnectors,
} from './sync';
import type { ActionBinding, Risk } from './types';

/** Which policy scope decided an action — surfaced so the editor can say so. */
type EffectiveSource = EffectiveResolveResult['source'];

const DEFAULT_AUTH: ConnectorAuth = {
  type: 'none',
  in: 'header',
  name: null,
  prefix: null,
};
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_REGEX.test(value);
}

function computerTunnelIds(configValue: unknown, slug: string): string[] | null {
  const config = (configValue ?? {}) as Record<string, unknown>;
  if (Array.isArray(config.tunnel_ids)) {
    return [
      ...new Set(config.tunnel_ids.filter((value): value is string => typeof value === 'string')),
    ];
  }
  if (typeof config.tunnel_id === 'string') return [config.tunnel_id];
  // Compatibility for durable sessions bound to the original aggregate row.
  return slug === COMPUTER_SLUG ? null : [];
}

function computerTunnelAccountIds(
  configValue: unknown,
  projectAccountId: string,
  slug: string,
): string[] | null {
  const config = (configValue ?? {}) as Record<string, unknown>;
  if (Array.isArray(config.tunnel_account_ids)) {
    return [
      ...new Set(
        config.tunnel_account_ids.filter(
          (value): value is string => typeof value === 'string' && value.length > 0,
        ),
      ),
    ];
  }
  return slug === COMPUTER_SLUG && !Array.isArray(config.tunnel_ids) ? null : [projectAccountId];
}

function isLegacyComputerAggregate(row: {
  providerType: string;
  slug: string;
  config: unknown;
}): boolean {
  if (row.providerType !== 'computer' || row.slug !== COMPUTER_SLUG) return false;
  const config = (row.config ?? {}) as Record<string, unknown>;
  return !Array.isArray(config.tunnel_ids) && typeof config.tunnel_id !== 'string';
}

async function principalHasLegacyComputerBinding(
  principal: ConnectorPrincipal,
  connectorId: string,
): Promise<boolean> {
  if (!principal.sessionId) return false;
  const [binding] = await db
    .select({ connectorId: projectSessionConnectorBindings.connectorId })
    .from(projectSessionConnectorBindings)
    .where(
      and(
        eq(projectSessionConnectorBindings.accountId, principal.accountId),
        eq(projectSessionConnectorBindings.projectId, principal.projectId),
        eq(projectSessionConnectorBindings.sessionId, principal.sessionId),
        eq(projectSessionConnectorBindings.connectorAlias, COMPUTER_SLUG),
        eq(projectSessionConnectorBindings.connectorId, connectorId),
      ),
    )
    .limit(1);
  return binding !== undefined;
}

/** How long an unconsumed human approve stays claimable by a fresh call. Long
 *  enough for the "agent gave up → approve lands → nudge/`continue` retries"
 *  round-trip, short enough that a stale yes can't silently authorize a much
 *  later call. */
const APPROVAL_CARRYOVER_WINDOW_MS = 15 * 60 * 1000;

/**
 * Claim a recent approval for one exact request digest. The guarded UPDATE on
 * the not-yet-consumed marker is atomic, so two racing calls cannot both claim
 * it. Newest approval first; one claim per approval.
 */
export async function consumeApprovedExecution(input: {
  sessionId: string | null;
  actingUserId: string;
  connectorId: string;
  actionPath: string;
  requestDigest: string;
}): Promise<boolean> {
  const cutoff = new Date(Date.now() - APPROVAL_CARRYOVER_WINDOW_MS);
  const candidates = await db
    .select({
      executionId: connectorCalls.executionId,
      resultSummary: connectorCalls.resultSummary,
    })
    .from(connectorCalls)
    .where(
      and(
        input.sessionId
          ? eq(connectorCalls.sessionId, input.sessionId)
          : isNull(connectorCalls.sessionId),
        eq(connectorCalls.actingUserId, input.actingUserId),
        eq(connectorCalls.connectorId, input.connectorId),
        eq(connectorCalls.actionPath, input.actionPath),
        eq(connectorCalls.requestDigest, input.requestDigest),
        // A human-approved gate: the resolve endpoint flips the pending row to
        // `ok` + stamps approvedBy. Rows from actual runs never have approvedBy.
        eq(connectorCalls.status, 'ok'),
        isNotNull(connectorCalls.approvedBy),
        gt(connectorCalls.resolvedAt, cutoff),
        sql`${connectorCalls.resultSummary} ->> 'decision' = 'approve'`,
        sql`${connectorCalls.resultSummary} ->> 'consumed_at' IS NULL`,
      ),
    )
    .orderBy(desc(connectorCalls.resolvedAt))
    .limit(3);
  for (const candidate of candidates) {
    const claimed = await db
      .update(connectorCalls)
      .set({
        resultSummary: {
          ...(typeof candidate.resultSummary === 'object' && candidate.resultSummary
            ? candidate.resultSummary
            : {}),
          consumed_at: new Date().toISOString(),
        },
      })
      .where(
        and(
          eq(connectorCalls.executionId, candidate.executionId),
          sql`${connectorCalls.resultSummary} ->> 'consumed_at' IS NULL`,
        ),
      )
      .returning({ id: connectorCalls.executionId });
    if (claimed.length > 0) return true;
  }
  return false;
}

/** Bind a legacy retry identifier to the exact unresolved request it names. */
export async function isPendingApprovalExecution(input: {
  executionId: string;
  projectId: string;
  sessionId: string | null;
  actingUserId: string;
  connectorId: string;
  actionPath: string;
  requestDigest: string;
}): Promise<boolean> {
  const [row] = await db
    .select({ executionId: connectorCalls.executionId })
    .from(connectorCalls)
    .where(
      and(
        eq(connectorCalls.executionId, input.executionId),
        eq(connectorCalls.projectId, input.projectId),
        input.sessionId
          ? eq(connectorCalls.sessionId, input.sessionId)
          : isNull(connectorCalls.sessionId),
        eq(connectorCalls.actingUserId, input.actingUserId),
        eq(connectorCalls.connectorId, input.connectorId),
        eq(connectorCalls.actionPath, input.actionPath),
        eq(connectorCalls.requestDigest, input.requestDigest),
        eq(connectorCalls.status, 'pending_approval'),
        isNull(connectorCalls.approvedBy),
        isNull(connectorCalls.resolvedAt),
      ),
    )
    .limit(1);
  return Boolean(row);
}

type ConnectorRow = typeof connectors.$inferSelect;

function authOf(row: ConnectorRow): { auth: ConnectorAuth; hasAuth: boolean } {
  const cfg = (row.config ?? {}) as Record<string, any>;
  const auth: ConnectorAuth = cfg.auth
    ? {
        type: cfg.auth.type,
        in: cfg.auth.in ?? 'header',
        name: cfg.auth.name ?? null,
        prefix: cfg.auth.prefix ?? null,
      }
    : DEFAULT_AUTH;
  const hasAuth = row.providerType === 'pipedream' || auth.type !== 'none';
  return { auth, hasAuth };
}

/**
 * The connector's static request headers (kortix.yaml `headers:`, persisted
 * into `config` by the materializer). Sanitized on the way out — a row written
 * before the header rules existed can never inject an illegal header.
 */
function headersOf(row: ConnectorRow): Record<string, string> {
  const cfg = (row.config ?? {}) as Record<string, any>;
  return sanitizeConnectorHeaders(cfg.headers);
}

function baseUrlOf(row: ConnectorRow): string | null {
  const cfg = (row.config ?? {}) as Record<string, any>;
  switch (row.providerType) {
    case 'openapi':
      return cfg.server ?? null;
    case 'http':
      return cfg.baseUrl ?? null;
    case 'graphql':
      return cfg.endpoint ?? null;
    case 'mcp':
      return cfg.url ?? null;
    case 'channel':
      return cfg.baseUrl ?? null;
    // computer: no base URL — the gateway relays via the tunnel core, not HTTP.
    case 'computer':
      return null;
    default:
      return null;
  }
}

/* ─── channel connectors: credential = the platform install token ──────────────
 * A channel connector has no connection_credentials row — its credential is the
 * existing platform install (resolved server-side, always fresh). These three
 * helpers are the single home for that dispatch; everything else stays generic.
 */
function channelPlatform(config: ConnectorRow['config'] | null): string | null {
  return (config as Record<string, any> | null)?.platform ?? null;
}

async function channelToken(
  projectId: string,
  platform: string | null,
  slug?: string | null,
): Promise<string | null> {
  if (platform === 'slack') return loadSlackTokenForProject(projectId);
  if (platform === 'teams') {
    const tenant = await loadTeamsTenantForProject(projectId);
    if (!tenant) return null;
    const creds = await loadTeamsBotCredentials(projectId);
    return graphToken(tenant, creds).catch(() => null);
  }
  if (platform === 'email')
    return resolveAgentMailApiKey(await loadAgentMailApiKeyForProject(projectId, slug));
  return null;
}

/** Cheap "is it connected?" — the install exists (no decrypt). */
async function channelInstalled(
  projectId: string,
  platform: string | null,
  slug?: string | null,
): Promise<boolean> {
  if (platform === 'slack') return (await loadSlackInstall(projectId).catch(() => null)) != null;
  if (platform === 'teams') return (await loadTeamsInstall(projectId).catch(() => null)) != null;
  if (platform === 'email')
    return (await loadAgentMailInstall(projectId, slug).catch(() => null)) != null;
  return false;
}

/**
 * Whether a connector's credential is present for `userId` — channel connectors
 * check their platform install; everyone else checks connection_credentials. One
 * place so the catalog + admin listings don't each re-branch on provider.
 */
async function connectorConnected(
  row: ConnectorRow,
  userId: string | null,
  connection?: {
    connectionId: string;
    isDefault: boolean;
    metadata: Record<string, unknown>;
  } | null,
): Promise<boolean> {
  if (row.providerType === 'channel') {
    const connectionSlug =
      typeof connection?.metadata.connector_slug === 'string'
        ? connection.metadata.connector_slug
        : row.slug;
    if (!(await channelInstalled(row.projectId, channelPlatform(row.config), connectionSlug))) {
      return false;
    }
    if (
      channelPlatform(row.config) === 'email' &&
      typeof connection?.metadata.inbox_id === 'string'
    ) {
      const install = await loadAgentMailInstall(row.projectId, connectionSlug).catch(() => null);
      return install?.inboxId === connection.metadata.inbox_id;
    }
    return true;
  }
  return connection
    ? (await connectionCredentialExists({
        connectorId: row.connectorId,
        connectionId: connection.connectionId,
      })) ||
        (connection.isDefault && (await credentialExists(row.connectorId, userId)))
    : credentialExists(row.connectorId, userId);
}

function toGatewayConnector(
  row: ConnectorRow,
  connection?: {
    connectionId: string;
    isDefault: boolean;
    metadata: Record<string, unknown>;
  } | null,
): GatewayConnector {
  const { auth, hasAuth } = authOf(row);
  const config = (row.config ?? {}) as Record<string, unknown>;
  return {
    connectorId: row.connectorId,
    authSecret: row.authSecret,
    connectionId: connection?.connectionId ?? null,
    connectionIsDefault: connection?.isDefault ?? false,
    connectionMetadata: connection?.metadata ?? {},
    slug: row.slug,
    provider: row.providerType,
    platform: channelPlatform(row.config),
    tunnelIds:
      row.providerType === 'computer' ? computerTunnelIds(row.config, row.slug) : undefined,
    tunnelAccountIds:
      row.providerType === 'computer'
        ? computerTunnelAccountIds(row.config, row.accountId, row.slug)
        : undefined,
    baseUrl: baseUrlOf(row),
    auth,
    headers: headersOf(row),
    hasAuth,
    // `per_user` was removed 2026-07-05; every row is `shared` (DB-enforced by
    // a CHECK constraint), so this is a defensive cast, not a live branch.
    credentialMode: 'shared',
    enabled: row.enabled,
    sensitive: (row.config as { sensitive?: unknown } | null)?.sensitive === true,
  };
}

/**
 * Resolve the one active connection this principal may use.
 *
 * Catalog discovery and call execution must use this same function. A session
 * with an explicit fail-closed scope cannot advertise a project-default connection
 * in the catalog and then lose it when the gateway resolves the call.
 */
async function resolveActiveConnectorConnection(principal: ConnectorPrincipal, row: ConnectorRow) {
  const connection = await resolveSessionConnectorConnection({
    accountId: principal.accountId,
    projectId: row.projectId,
    sessionId: principal.sessionId,
    alias: row.slug,
    actingUserId: principal.userId,
  });
  return connection?.status === 'active' ? connection : null;
}

const nodeFetch: FetchImpl = async (url, init) => {
  const res = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    ...(init.tls ? { tls: init.tls } : {}),
  } as RequestInit);
  return { status: res.status, ok: res.ok, text: () => res.text() };
};

export function makeDbGatewayDeps(principal: ConnectorPrincipal): GatewayDeps {
  return {
    attachmentStore: connectorAttachmentStore,
    loadConnectorBySlug: async (projectId, slug) => {
      const [row] = await db
        .select()
        .from(connectors)
        .where(and(eq(connectors.projectId, projectId), eq(connectors.slug, slug)))
        .limit(1);
      if (!row) return null;
      if (
        isLegacyComputerAggregate(row) &&
        !(await principalHasLegacyComputerBinding(principal, row.connectorId))
      ) {
        return null;
      }
      const connection = await resolveActiveConnectorConnection(principal, row);
      if (!connection) return null;
      return toGatewayConnector(row, connection);
    },
    loadAction: async (connectorId, relPath) => {
      const [a] = await db
        .select()
        .from(connectorActions)
        .where(
          and(eq(connectorActions.connectorId, connectorId), eq(connectorActions.path, relPath)),
        )
        .limit(1);
      if (!a) return null;
      return {
        path: a.path,
        relPath: a.path,
        inputSchema: a.inputSchema ?? null,
        risk: a.risk as Risk,
        binding: a.binding as unknown as ActionBinding,
      } satisfies GatewayAction;
    },
    resolveCredential: async (connector, userId) => {
      // Channel connectors resolve to their platform install token (server-side);
      // the provider is already in hand, so only the channel path does a lookup —
      // every other connector takes the original connection_credentials path.
      if (connector.provider === 'channel') {
        const [row] = await db
          .select({
            projectId: connectors.projectId,
            slug: connectors.slug,
            config: connectors.config,
          })
          .from(connectors)
          .where(eq(connectors.connectorId, connector.connectorId))
          .limit(1);
        const connectionSlug =
          typeof connector.connectionMetadata?.connector_slug === 'string'
            ? connector.connectionMetadata.connector_slug
            : row?.slug;
        return row
          ? channelToken(row.projectId, channelPlatform(row.config), connectionSlug)
          : null;
      }
      if (connector.connectionId) {
        const credential = await resolveConnectionCredentialValue({
          connectorId: connector.connectorId,
          connectionId: connector.connectionId,
        });
        if (credential !== null) return credential;
        if (!connector.connectionIsDefault) return null;
      }
      const storedCredential =
        connector.connectionIsDefault || !connector.connectionId
          ? await resolveCredentialValue(connector.connectorId, userId)
          : null;
      if (storedCredential !== null) return storedCredential;
      if (!connector.authSecret) return null;
      return getProjectSecretValueForConsumer({
        projectId: principal.projectId,
        accountId: principal.accountId,
        sessionId: principal.sessionId,
        actorUserId: principal.userId,
        name: connector.authSecret,
        consumer: 'connector',
      });
    },
    // Session metadata is user-writable, so it is not a trusted routing source
    // for inbox, thread, or message identifiers. A future channel-owned binding
    // may provide this context; until then callers must pass explicit action args.
    loadEmailSessionContext: async () => null,
    loadEmailConnectorContext: async (projectId, connectorSlug) => {
      const install = await loadAgentMailInstall(projectId, connectorSlug).catch(() => null);
      return install?.inboxId ? { inboxId: install.inboxId } : null;
    },
    resolveEmailCredentialForInbox: async (projectId, inboxId) =>
      resolveAgentMailApiKey(await loadAgentMailApiKeyForInbox(projectId, inboxId)),
    loadPolicies: loadConnectorPoliciesFor,
    loadProjectPolicies: loadProjectPoliciesFor,
    loadDefaultMode: loadDefaultModeFor,
    mintApprovalLink: ({ projectId, executionId, sessionId }) =>
      approvalPageUrl(projectId, executionId, sessionId, config.FRONTEND_URL),
    recordExecution: async (rec) => {
      const [row] = await db
        .insert(connectorCalls)
        .values({
          accountId: rec.accountId,
          projectId: rec.projectId,
          connectorId: rec.connectorId,
          connectionId: rec.connectionId,
          actionPath: rec.actionPath,
          actingUserId: rec.actingUserId,
          sessionId: rec.sessionId,
          status: rec.status,
          risk: rec.risk,
          requestDigest: rec.requestDigest ?? null,
          resultSummary: rec.resultSummary,
          // A pending_approval row is genuinely UNRESOLVED — it's awaiting a human
          // approve/deny (the approvals inbox). Every terminal status (ok/error/
          // denied) resolves at insert. Leaving pending rows unresolved is what lets
          // the inbox query surface exactly the actions still waiting on a decision.
          resolvedAt: rec.status === 'pending_approval' ? null : new Date(),
        })
        .returning({ id: connectorCalls.executionId });
      if (!row?.id) return null;
      return row.id;
    },
    consumeApprovedExecution: consumeApprovedExecution,
    isPendingApprovalExecution: isPendingApprovalExecution,
    executePipedream: ({ projectId, connectorSlug, app, actionKey, args, accountId, userId }) =>
      runPipedreamAction(projectId, connectorSlug, app, actionKey, args, accountId, userId),
    executePipedreamProxy: ({ projectId, connectorSlug, args, accountId, userId }) =>
      runPipedreamProxy(projectId, connectorSlug, args, accountId, userId),
    // Computers connectors relay through the shared tunnel RPC core (profile
    // allowlist → account ownership → permission check → relay → audit).
    executeComputerCall: ({
      accountId,
      projectId,
      sessionId,
      actorUserId,
      allowedTunnelIds,
      allowedTunnelAccountIds,
      selector,
      method,
      args,
    }) =>
      executeComputerCall({
        accountId,
        projectId,
        sessionId,
        actorUserId,
        allowedTunnelIds,
        allowedTunnelAccountIds,
        selector,
        method,
        args,
      }),
    // Voice channel: `spawn_room` creates the LiveKit room + human join token
    // (the same logic voice/routes.ts used to inline before it went through
    // the gateway); `join_gmeet`/`join_zoom` are declared but not implemented
    // yet, so they fail loud with what to do instead rather than pretending.
    executeVoiceCall: async ({ projectId, sessionId, op, args }) => {
      if (op === 'join_gmeet' || op === 'join_zoom') {
        const platform = op === 'join_gmeet' ? 'Google Meet' : 'Zoom';
        return {
          ok: false,
          kind: 'not_implemented',
          message: `joining an existing ${platform} is not supported yet — use spawn_room and share the join link instead`,
        };
      }
      // The call id IS the session id, so every action below addresses "this
      // session's call" without the agent having to carry a call id around.
      if (op === 'read_transcript') {
        if (!sessionId) {
          return {
            ok: false,
            kind: 'error',
            message: 'read_transcript requires a session',
          };
        }
        // Mode resolution, the per-call read position, the page shape and the
        // unread count all live in channels/voice/transcript-read.ts — read its
        // header for why a bare call is the cheap one, and for what happens to
        // "unread" turns when a turn dies mid-read. Everything except liveness,
        // which is a LiveKit question, not a transcript one.
        const read = await readTranscriptForAgent({
          callId: sessionId,
          projectId,
          args,
        });
        return {
          ok: true,
          data: { ...read, live: await isCallLive(sessionId) },
        };
      }

      if (op === 'send_prompt') {
        if (!sessionId) {
          return {
            ok: false,
            kind: 'error',
            message: 'send_prompt requires a session',
          };
        }
        const text = typeof args.text === 'string' ? args.text.trim() : '';
        if (!text) {
          return {
            ok: false,
            kind: 'error',
            message: 'send_prompt requires `text`',
          };
        }
        // `kortixSay` carries both halves of this utterance: the framing the
        // voice model needs (it is handed the text as INSTRUCTIONS, so raw text
        // reads as an unattributed order — that is what made the call answer
        // statements as questions) AND the plain line that gets written to
        // voice_call_turns, so what this agent says into the call is actually in
        // the call's record. `projectId` is passed because we have it here; the
        // in-call paths (turn.ts, answer-watch.ts) look it up instead.
        const result = await promptVoiceAgent(sessionId, kortixSay(text), {
          projectId,
        });
        if (!result.delivered) {
          // Deliberately an error, not a silent success: an agent that believes
          // it spoke and did not will carry on as though the room heard it.
          return {
            ok: false,
            kind: 'error',
            message: result.reason ?? 'could not reach the call',
          };
        }
        return { ok: true, data: { spoken: true } };
      }

      if (op === 'end_call') {
        if (!sessionId) {
          return {
            ok: false,
            kind: 'error',
            message: 'end_call requires a session',
          };
        }
        await endCall(sessionId);
        return { ok: true, data: { ended: true } };
      }

      if (op !== 'spawn_room') {
        return {
          ok: false,
          kind: 'error',
          message: `unknown voice action "${op}"`,
        };
      }
      if (!sessionId) {
        return {
          ok: false,
          kind: 'error',
          message: 'spawn_room requires a session',
        };
      }
      const voice = typeof args.voice === 'string' ? args.voice : null;
      const botName = await resolveProjectBotName(projectId);
      // The call id IS the session id — one live call per session.
      const callId = sessionId;
      // Start the room BEFORE minting the human's join link. If a person opens
      // the page first it would try to join a room that does not exist yet,
      // and that join is rejected with nothing to retry against.
      await startCall({ callId, projectId, sessionId, botName, voice });
      // Hand out a short, ungessable link that resolves to a freshly-minted
      // LiveKit access token server-side (public-join-routes.ts), rather than
      // embedding the ~300-char signed JWT itself in the URL — see
      // join-links.ts's header for why (a single corrupted character in
      // transit used to break the signature with no way to retry).
      const { token: joinToken } = await mintJoinLink({ callId, projectId });
      const joinUrl = joinPageUrl(config.FRONTEND_URL, joinToken);
      return { ok: true, data: { call_id: callId, join_url: joinUrl } };
    },
    fetchImpl: nodeFetch,
    enforcePolicies: true,
  };
}

async function loadConnectorPoliciesFor(connectorId: string): Promise<Policy[]> {
  const rows = await db
    .select()
    .from(connectorPolicies)
    .where(eq(connectorPolicies.connectorId, connectorId));
  return rows.map((r) => ({
    match: r.match,
    action: r.action,
    position: r.position,
    // Conditions are re-validated on READ, never trusted from storage.
    ...parseStoredConditions(r.conditions),
  }));
}

async function loadProjectPoliciesFor(projectId: string): Promise<Policy[]> {
  const rows = await db
    .select()
    .from(connectorProjectPolicies)
    .where(eq(connectorProjectPolicies.projectId, projectId));
  return rows.map((r) => ({
    match: r.match,
    action: r.action,
    position: r.position,
    ...parseStoredConditions(r.conditions),
  }));
}

async function loadDefaultModeFor(projectId: string): Promise<DefaultMode> {
  const [row] = await db
    .select({ defaultMode: connectorProjectSettings.defaultMode })
    .from(connectorProjectSettings)
    .where(eq(connectorProjectSettings.projectId, projectId))
    .limit(1);
  return (row?.defaultMode as DefaultMode) ?? 'allow_all';
}

/** Load a pipedream connector's app slug + id (verifies provider). */
export async function loadPipedreamConnector(projectId: string, slug: string) {
  const [row] = await db
    .select({
      connectorId: connectors.connectorId,
      providerType: connectors.providerType,
      config: connectors.config,
      authorizationStrategy: connectors.authorizationStrategy,
    })
    .from(connectors)
    .where(and(eq(connectors.projectId, projectId), eq(connectors.slug, slug)))
    .limit(1);
  if (!row || row.providerType !== 'pipedream') return null;
  const app = (row.config as any)?.app;
  if (typeof app !== 'string' || !app) return null;
  return {
    connectorId: row.connectorId,
    app,
    authorizationStrategy: row.authorizationStrategy,
  };
}

export type ConnectLinkEligibility =
  | {
      ok: true;
      connectorId: string;
      app: string;
      authorizationStrategy: string;
    }
  /** No connector with this slug on the project. The manifest really is missing it. */
  | { ok: false; reason: 'no_such_connector' }
  /** It exists, but a setup link is a Pipedream Quick Connect and this is not one. */
  | { ok: false; reason: 'not_pipedream'; providerType: string }
  /** Pipedream-backed but its config names no app — a broken connector, not a missing one. */
  | { ok: false; reason: 'no_app' };

/**
 * Why a connect link can or cannot be minted for this slug.
 *
 * `loadPipedreamConnector` answers all three failures with `null`, so the mint
 * route told everyone to "add it to kortix.yaml first" — including the people
 * whose connector is already in kortix.yaml and simply is not Pipedream-backed.
 * That sends someone to edit a file that already has the entry they are being
 * asked to add, and the connector they actually need is reachable by a route
 * this one cannot offer.
 */
export async function connectLinkEligibility(
  projectId: string,
  slug: string,
): Promise<ConnectLinkEligibility> {
  const [row] = await db
    .select({
      connectorId: connectors.connectorId,
      providerType: connectors.providerType,
      config: connectors.config,
      authorizationStrategy: connectors.authorizationStrategy,
    })
    .from(connectors)
    .where(and(eq(connectors.projectId, projectId), eq(connectors.slug, slug)))
    .limit(1);
  if (!row) return { ok: false, reason: 'no_such_connector' };
  if (row.providerType !== 'pipedream') {
    return {
      ok: false,
      reason: 'not_pipedream',
      providerType: row.providerType,
    };
  }
  const app = (row.config as any)?.app;
  if (typeof app !== 'string' || !app) return { ok: false, reason: 'no_app' };
  return {
    ok: true,
    connectorId: row.connectorId,
    app,
    authorizationStrategy: row.authorizationStrategy,
  };
}

export function resolveTokenBoundSessionId(
  authenticatedSessionId: string | null,
  requestedSessionId: string | null,
): { ok: true; sessionId: string | null } | { ok: false } {
  if (requestedSessionId && requestedSessionId !== authenticatedSessionId) {
    return { ok: false };
  }
  return { ok: true, sessionId: authenticatedSessionId };
}

/**
 * Only project-scoped tokens carry a Kortix project session identity.
 * Supabase JWTs also set `sessionId`, but that value identifies the Supabase
 * authentication session. It must not enter connection resolution.
 */
export function projectSessionIdForProjectPrincipal(
  tokenProjectId: string | undefined,
  contextualSessionId: string | undefined,
): string | null {
  return tokenProjectId ? (contextualSessionId ?? null) : null;
}

async function resolvePrincipal(c: Context): Promise<ConnectorPrincipal | null> {
  const header = c.req.header('Authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  const result = await validateAccountToken(token);
  if (!result.isValid || !result.userId || !result.accountId || !result.projectId) return null;
  const sessionIdentity = resolveTokenBoundSessionId(
    result.sessionId ?? null,
    c.req.header('X-Kortix-Session-Id') ?? null,
  );
  if (!sessionIdentity.ok) return null;
  const agentGrant = sessionIdentity.sessionId
    ? await reconcileStoredSessionAgentGrant({
        projectId: result.projectId,
        sessionId: sessionIdentity.sessionId,
      })
    : (result.agentGrant ?? null);
  return {
    userId: result.userId,
    accountId: result.accountId,
    projectId: result.projectId,
    sessionId: sessionIdentity.sessionId,
    subject: await resolveShareSubject(result.userId),
    agentGrant,
  };
}

/**
 * Principal for the project-EXPLICIT gateway routes (/connectors/projects/:id/*).
 * These run under combinedAuth, so identity is already validated and sits in the
 * context; the project comes from the PATH. Works for BOTH a project-scoped
 * session token (enforceTokenProjectScope already pinned it to this project) AND
 * a logged-in user token (verified to be a project member here). This is the
 * unlock for using the Connector locally: same gateway, same authz, any principal.
 */
async function resolveProjectPrincipal(
  c: Context,
  projectId: string,
): Promise<ConnectorPrincipal | null> {
  if (!isUuid(projectId)) return null;
  const userId = c.get('userId') as string | undefined;
  if (!userId) return null;
  const tokenProjectId = c.get('tokenProjectId') as string | undefined;
  let accountId = c.get('accountId') as string | undefined;

  if (tokenProjectId) {
    // Project-scoped (session) token: enforceTokenProjectScope already guaranteed
    // tokenProjectId === the URL project at the auth layer. Re-check defensively,
    // then bind the token account to the actual project account. This prevents a
    // PAT row from one account from being labeled with another account's project
    // id and then used on the project-explicit Connector gateway.
    if (tokenProjectId !== projectId) return null;
    const [project] = await db
      .select({ accountId: projects.accountId })
      .from(projects)
      .where(eq(projects.projectId, projectId))
      .limit(1);
    if (!project || !accountId || project.accountId !== accountId) return null;
    accountId = project.accountId;
  } else {
    // User token (PAT/JWT, no pinned project): verify project access. Throws 403
    // if the user isn't a member — treat that as an unauthorized principal.
    try {
      const access = await loadProjectForUser(c, projectId, 'read');
      if (!access?.row) return null;
      accountId = access.row.accountId; // the PROJECT's account owns its connectors
    } catch (err) {
      if (err instanceof HTTPException && err.status === 403) return null;
      throw err;
    }
  }
  if (!accountId) return null;
  const sessionIdentity = resolveTokenBoundSessionId(
    projectSessionIdForProjectPrincipal(tokenProjectId, c.get('sessionId') as string | undefined),
    c.req.header('X-Kortix-Session-Id') ?? null,
  );
  if (!sessionIdentity.ok) return null;

  const storedAgentGrant = (c.get('agentGrant') as ConnectorPrincipal['agentGrant']) ?? null;
  const agentGrant = sessionIdentity.sessionId
    ? await reconcileStoredSessionAgentGrant({
        projectId,
        sessionId: sessionIdentity.sessionId,
      })
    : storedAgentGrant;

  return {
    userId,
    accountId,
    projectId,
    sessionId: sessionIdentity.sessionId,
    subject: await resolveShareSubject(userId),
    agentGrant,
  };
}

/** The catalog a principal can actually use (agent grant + credential present + not blocked). */
async function listCatalog(p: ConnectorPrincipal): Promise<CatalogConnector[]> {
  const conns = hideSupersededSlack(
    await db
      .select()
      .from(connectors)
      .where(and(eq(connectors.projectId, p.projectId), eq(connectors.enabled, true))),
  );

  // Project-scoped layer is the same for every connector in this list — load once.
  const [projectPolicies, defaultMode] = await Promise.all([
    loadProjectPoliciesFor(p.projectId),
    loadDefaultModeFor(p.projectId),
  ]);

  const out: CatalogConnector[] = [];
  for (const row of conns) {
    if (
      isLegacyComputerAggregate(row) &&
      !(await principalHasLegacyComputerBinding(p, row.connectorId))
    ) {
      continue;
    }
    // Per-agent assignment: an agent only sees connectors its grant lists —
    // consistent with the call gate, so it never lists a tool it can't invoke.
    // This is the ONLY access gate — connectors are project-wide visible to
    // every human with project access (no per-connector member scoping).
    // Canonical on both sides — the grant is canonicalized at construction.
    if (!agentMayUseConnector(p.agentGrant ?? null, canonicalConnectorAlias(row.slug))) continue;
    const connection = await resolveActiveConnectorConnection(p, row);
    if (!connection) continue;
    const { hasAuth } = authOf(row);
    if (hasAuth) {
      // Always the shared credential — `per_user` was removed 2026-07-05.
      if (!(await connectorConnected(row, null, connection))) continue;
    }
    const connectorPolicies = await loadConnectorPoliciesFor(row.connectorId);
    const actions = await db
      .select()
      .from(connectorActions)
      .where(eq(connectorActions.connectorId, row.connectorId));
    out.push({
      slug: row.slug,
      name: row.name,
      provider: row.providerType,
      platform: channelPlatform(row.config),
      status: row.status,
      actions: actions
        .filter(
          (a) =>
            resolveEffectiveAction({
              fullPath: `${row.slug}.${a.path}`,
              relPath: a.path,
              projectPolicies,
              connectorPolicies,
              risk: a.risk,
              defaultMode,
            }).action !== 'block',
        )
        .map((a) => ({
          path: a.path,
          name: a.name,
          description: a.description ?? '',
          risk: a.risk,
          inputSchema: a.inputSchema ?? null,
        })),
    });
  }
  return out;
}

async function resolveProjectUserWith(
  c: Context,
  projectId: string,
  action:
    | typeof PROJECT_ACTIONS.PROJECT_CONNECTOR_READ
    | typeof PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE
    | typeof PROJECT_ACTIONS.PROJECT_SECRET_READ
    | typeof PROJECT_ACTIONS.PROJECT_SECRET_WRITE,
): Promise<{ accountId: string; userId: string } | null> {
  if (!isUuid(projectId)) return null;
  const userId = c.get('userId') as string | undefined;
  if (!userId) return null;
  const [proj] = await db
    .select({ accountId: projects.accountId })
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);
  if (!proj) return null;
  // Thread the acting token (iamTokenId) so the agent-grant fold fires: a
  // scoped agent-session token must actually hold the leaf, and a custom role
  // can withhold it from humans too.
  const actingTokenId = (c.get('iamTokenId') as string | undefined) ?? undefined;
  const decision = await authorize(
    userId,
    proj.accountId,
    action,
    { type: 'project', id: projectId },
    actingTokenId,
  );
  if (!decision.allowed) return null;
  return { accountId: proj.accountId, userId };
}

// Connector administration (create/delete connectors, write shared credentials,
// grants/policies) is project.connector.write — NOT the coarse, fold-exempt
// project.write.
async function resolveAdmin(
  c: Context,
  projectId: string,
): Promise<{ accountId: string; userId: string } | null> {
  return resolveProjectUserWith(c, projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE);
}

async function resolveSecretBindingAdmin(
  c: Context,
  projectId: string,
): Promise<{ accountId: string; userId: string } | null> {
  const connectorAdmin = await resolveProjectUserWith(
    c,
    projectId,
    PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE,
  );
  if (!connectorAdmin) return null;
  const secretAdmin = await resolveProjectUserWith(
    c,
    projectId,
    PROJECT_ACTIONS.PROJECT_SECRET_WRITE,
  );
  return secretAdmin ? connectorAdmin : null;
}

// The connectors LIST is read-tier: project.connector.read is in the member
// baseline (the Connectors/Channels rail sections gate visibility on it), so a
// plain member can see which connectors exist and their status. The list never
// carries credential values — only whether one is set.
async function resolveReader(
  c: Context,
  projectId: string,
): Promise<{ accountId: string; userId: string } | null> {
  return resolveProjectUserWith(c, projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_READ);
}

async function resolveSecretReader(
  c: Context,
  projectId: string,
): Promise<{ accountId: string; userId: string } | null> {
  return resolveProjectUserWith(c, projectId, PROJECT_ACTIONS.PROJECT_SECRET_READ);
}

/** Admin list — sharing + credential mode + whether the shared credential is set. */
async function listConnectors(projectId: string): Promise<AdminConnectorView[]> {
  const conns = hideSupersededSlack(
    await db.select().from(connectors).where(eq(connectors.projectId, projectId)),
  ).filter((row) => !isLegacyComputerAggregate(row));
  if (conns.length === 0) return [];

  const credentialRows = conns.filter((row) => {
    const { hasAuth } = authOf(row);
    return hasAuth && row.providerType !== 'channel';
  });
  const channelRows = conns.filter((row) => {
    const { hasAuth } = authOf(row);
    return hasAuth && row.providerType === 'channel';
  });
  const boundSecretIdentifiers = [
    ...new Set(
      credentialRows
        .map((row) => row.authSecret)
        .filter((identifier): identifier is string => Boolean(identifier)),
    ),
  ];
  const [actions, credentialConnectorIds, connectedChannelSlugs, validBoundSecrets] =
    await Promise.all([
      db
        .select()
        .from(connectorActions)
        .where(
          inArray(
            connectorActions.connectorId,
            conns.map((row) => row.connectorId),
          ),
        ),
      connectorIdsWithSharedCredentials(credentialRows.map((row) => row.connectorId)),
      Promise.all(
        channelRows.map(async (row) => [row.slug, await connectorConnected(row, null)] as const),
      ).then(
        (entries) => new Set(entries.filter(([, connected]) => connected).map(([slug]) => slug)),
      ),
      boundSecretIdentifiers.length === 0
        ? Promise.resolve([])
        : db
            .select({ identifier: projectSecrets.identifier })
            .from(projectSecrets)
            .where(
              and(
                eq(projectSecrets.projectId, projectId),
                inArray(projectSecrets.identifier, boundSecretIdentifiers),
                isNull(projectSecrets.ownerUserId),
                eq(projectSecrets.active, true),
                eq(projectSecrets.strategy, 'broker'),
                eq(projectSecrets.consumer, 'connector'),
              ),
            ),
    ]);
  const actionsByConnector = new Map<string, typeof actions>();
  for (const action of actions) {
    const current = actionsByConnector.get(action.connectorId) ?? [];
    current.push(action);
    actionsByConnector.set(action.connectorId, current);
  }

  const connectedSlugs = new Set(connectedChannelSlugs);
  const storedCredentialSlugs = new Set<string>();
  for (const row of credentialRows) {
    if (credentialConnectorIds.has(row.connectorId)) {
      connectedSlugs.add(row.slug);
      storedCredentialSlugs.add(row.slug);
    }
  }
  const validBoundSecretIdentifiers = new Set(validBoundSecrets.map((row) => row.identifier));
  for (const row of credentialRows) {
    if (row.authSecret && validBoundSecretIdentifiers.has(row.authSecret)) {
      connectedSlugs.add(row.slug);
    }
  }
  const candidates = conns.map((row) => {
    const { auth, hasAuth } = authOf(row);
    const config = row.config as {
      icon_url?: unknown;
      sensitive?: unknown;
    } | null;
    return {
      slug: row.slug,
      name: row.name,
      provider: row.providerType,
      platform: channelPlatform(row.config),
      iconUrl: typeof config?.icon_url === 'string' ? config.icon_url : null,
      status: row.status,
      authorizationStrategy: row.authorizationStrategy,
      sensitive: config?.sensitive === true,
      actions: (actionsByConnector.get(row.connectorId) ?? []).map((a) => ({
        path: a.path,
        name: a.name,
        description: a.description ?? '',
        risk: a.risk,
        inputSchema: a.inputSchema ?? null,
      })),
      requestAuthType: auth.type,
      requiresAuth: hasAuth,
      secretIdentifier: row.authSecret,
      credentialSource: !hasAuth
        ? ('none' as const)
        : row.providerType === 'channel'
          ? ('platform' as const)
          : storedCredentialSlugs.has(row.slug)
            ? ('stored' as const)
            : row.authSecret
              ? ('project_secret' as const)
              : ('none' as const),
    };
  });
  return buildAdminConnectorViews(candidates, connectedSlugs);
}

async function setConnectorSecretBinding(
  projectId: string,
  slug: string,
  secretIdentifier: string | null,
) {
  const [connector] = await db
    .select()
    .from(connectors)
    .where(and(eq(connectors.projectId, projectId), eq(connectors.slug, slug)))
    .limit(1);
  if (!connector) return { ok: false as const, error: 'connector not found', status: 404 };

  if (secretIdentifier === null) {
    await db
      .update(connectors)
      .set({ authSecret: null, updatedAt: new Date() })
      .where(eq(connectors.connectorId, connector.connectorId));
    return { ok: true as const };
  }

  const [secret] = await db
    .select({ secretId: projectSecrets.secretId })
    .from(projectSecrets)
    .where(
      and(
        eq(projectSecrets.projectId, projectId),
        eq(projectSecrets.identifier, secretIdentifier),
        isNull(projectSecrets.ownerUserId),
        eq(projectSecrets.active, true),
        eq(projectSecrets.strategy, 'broker'),
        eq(projectSecrets.consumer, 'connector'),
      ),
    )
    .limit(1);
  const validation = validateConnectorSecretBinding({
    secretIdentifier,
    requiresAuth: authOf(connector).hasAuth,
    provider: connector.providerType,
    authorizationStrategy: connector.authorizationStrategy,
    hasStoredCredential: await credentialExists(connector.connectorId, null),
    secretCompatible: Boolean(secret),
  });
  if (validation) return { ok: false as const, ...validation };

  await db
    .update(connectors)
    .set({ authSecret: secretIdentifier, updatedAt: new Date() })
    .where(eq(connectors.connectorId, connector.connectorId));
  return { ok: true as const };
}

/**
 * Read a connector's per-tool policies for the dashboard/settings surface.
 *
 * Return materialized policy rows when the connector exists in the runtime
 * catalog. The write route commits kortix.yaml and then synchronizes these rows.
 * Reading the manifest again can return a stale git view immediately after the
 * write, which makes the CLI report no rules while the gateway enforces them.
 * Synthetic channel/computer connectors also exist only in the runtime catalog.
 * Use the manifest only when a declared connector has not materialized yet.
 */
async function getConnectorPolicies(
  projectId: string,
  slug: string,
): Promise<{
  policies: Array<{ match: string; action: string }>;
  effective: Array<{
    path: string;
    action: PolicyAction;
    source: EffectiveSource;
  }>;
  project_policies: Array<{ match: string; action: string }>;
  default_mode: DefaultMode;
} | null> {
  const [fromManifest, [row]] = await Promise.all([
    getConnectorPoliciesFromManifest(projectId, slug),
    db
      .select({
        connectorId: connectors.connectorId,
        config: connectors.config,
      })
      .from(connectors)
      .where(and(eq(connectors.projectId, projectId), eq(connectors.slug, slug)))
      .limit(1),
  ]);
  if (!fromManifest && !row) return null;

  const materialized = row
    ? (await loadConnectorPoliciesFor(row.connectorId)).map((p) => ({
        match: p.match,
        action: p.action,
      }))
    : null;
  const policies = selectPoliciesForRead(materialized, fromManifest?.policies ?? null)!;

  // The editor also needs to know WHICH scope decides each tool. A project-scope
  // rule is evaluated first and cannot be overridden here (see policy.ts), so
  // without this the panel would happily show a connector rule the runtime is
  // ignoring. Resolve every action through the same function the call gate uses.
  if (!row) {
    return {
      policies,
      effective: [],
      project_policies: [],
      default_mode: 'allow_all',
    };
  }
  const [projectPolicies, defaultMode, actions] = await Promise.all([
    loadProjectPoliciesFor(projectId),
    loadDefaultModeFor(projectId),
    db.select().from(connectorActions).where(eq(connectorActions.connectorId, row.connectorId)),
  ]);
  const sensitive = (row.config as { sensitive?: unknown } | null)?.sensitive === true;
  const connectorPolicies: Policy[] = policies.map((p) => ({
    match: p.match,
    action: p.action as PolicyAction,
  }));
  const effective = actions.map((a) => {
    const resolved = resolveEffectiveAction({
      fullPath: `${slug}.${a.path}`,
      relPath: a.path,
      projectPolicies,
      connectorPolicies,
      risk: a.risk,
      defaultMode,
      sensitive,
    });
    return { path: a.path, action: resolved.action, source: resolved.source };
  });
  return {
    policies,
    effective,
    project_policies: projectPolicies.map((p) => ({
      match: p.match,
      action: p.action,
    })),
    default_mode: defaultMode,
  };
}

/**
 * Read a connector's definition for the editor. Same manifest-first / DB-fallback
 * rule as getConnectorPolicies: synthetic channel/computer connectors aren't in
 * kortix.yaml, so reconstruct the view from the materialized row instead of 404ing.
 */
async function getConnectorConfig(
  projectId: string,
  slug: string,
): Promise<Awaited<ReturnType<typeof getConnectorConfigFromManifest>>> {
  const fromManifest = await getConnectorConfigFromManifest(projectId, slug);
  if (fromManifest) return fromManifest;
  const [row] = await db
    .select()
    .from(connectors)
    .where(and(eq(connectors.projectId, projectId), eq(connectors.slug, slug)))
    .limit(1);
  if (!row) return null;
  const cfg = (row.config ?? {}) as Record<string, any>;
  const { auth } = authOf(row);
  return {
    slug: row.slug,
    name: row.name,
    provider: row.providerType,
    platform: channelPlatform(row.config) as ChannelPlatform | null,
    credentialMode: 'shared',
    authorizationStrategy: row.authorizationStrategy,
    app: cfg.app ?? null,
    account: cfg.account ?? null,
    url: cfg.url ?? null,
    transport: cfg.transport ?? null,
    endpoint: cfg.endpoint ?? null,
    baseUrl: baseUrlOf(row),
    spec: cfg.spec ?? null,
    tunnelIds:
      row.providerType === 'computer' ? (computerTunnelIds(row.config, row.slug) ?? []) : undefined,
    auth: {
      type: auth.type,
      in: auth.in,
      name: auth.name,
      prefix: auth.prefix,
    },
    headers: headersOf(row),
  };
}

type ConnectorCrudResult = Awaited<ReturnType<typeof setConnectorPoliciesInManifest>>;

async function computerConnectorId(
  projectId: string,
  accountId: string,
  slug: string,
): Promise<string | null> {
  const [row] = await db
    .select({ connectorId: connectors.connectorId })
    .from(connectors)
    .where(
      and(
        eq(connectors.projectId, projectId),
        eq(connectors.accountId, accountId),
        eq(connectors.slug, slug),
        eq(connectors.providerType, 'computer'),
      ),
    )
    .limit(1);
  return row?.connectorId ?? null;
}

async function setComputerConnectorPolicies(
  projectId: string,
  accountId: string,
  slug: string,
  policies: Array<{ match: string; action: string }>,
): Promise<ConnectorCrudResult | null> {
  const connectorId = await computerConnectorId(projectId, accountId, slug);
  if (!connectorId) return null;

  const allowedActions = new Set<PolicyAction>(['always_run', 'require_approval', 'block']);
  for (const [index, policy] of policies.entries()) {
    if (typeof policy?.match !== 'string' || !policy.match.trim()) {
      return {
        ok: false,
        error: `rule #${index + 1}: \`match\` is required`,
        status: 400,
      };
    }
    if (!isValidMatcher(policy.match.trim())) {
      return {
        ok: false,
        error: `rule #${index + 1}: invalid regex pattern`,
        status: 400,
      };
    }
    if (!allowedActions.has(policy.action as PolicyAction)) {
      return {
        ok: false,
        error: `rule #${index + 1}: \`action\` must be always_run | require_approval | block`,
        status: 400,
      };
    }
  }

  await setMaterializedComputerConnectorPolicies(
    connectorId,
    policies.map((policy) => ({
      match: policy.match.trim(),
      action: policy.action as PolicyAction,
    })),
  );
  return { ok: true };
}

async function setComputerConnectorSensitive(
  projectId: string,
  accountId: string,
  slug: string,
  sensitive: boolean,
): Promise<ConnectorCrudResult | null> {
  const connectorId = await computerConnectorId(projectId, accountId, slug);
  if (!connectorId) return null;
  const configPatch = sensitive
    ? sql`coalesce(${connectors.config}, '{}'::jsonb) || '{"sensitive": true}'::jsonb`
    : sql`coalesce(${connectors.config}, '{}'::jsonb) - 'sensitive'`;
  await db
    .update(connectors)
    .set({ config: configPatch, updatedAt: new Date() })
    .where(eq(connectors.connectorId, connectorId));
  return { ok: true };
}

const MAX_COMPUTERS_PER_PROFILE = 100;

async function upsertComputerConnectorProfile(
  projectId: string,
  accountId: string,
  draft: Record<string, unknown>,
  actorUserId?: string,
): Promise<ConnectorCrudResult | null> {
  if (draft.provider !== 'computer') return null;
  const slug = typeof draft.slug === 'string' ? draft.slug.trim() : '';
  if (!SLUG_RE.test(slug)) {
    return { ok: false, error: 'invalid connector slug', status: 400 };
  }
  const rawTunnelIds = draft.tunnel_ids;
  if (!Array.isArray(rawTunnelIds)) {
    return { ok: false, error: 'tunnel_ids must be an array', status: 400 };
  }
  const tunnelIds = [
    ...new Set(rawTunnelIds.filter((value): value is string => typeof value === 'string')),
  ];
  if (tunnelIds.length === 0) {
    return { ok: false, error: 'select at least one computer', status: 400 };
  }
  if (tunnelIds.length !== rawTunnelIds.length || tunnelIds.some((value) => !isUuid(value))) {
    return {
      ok: false,
      error: 'tunnel_ids must contain unique UUIDs',
      status: 400,
    };
  }
  if (tunnelIds.length > MAX_COMPUTERS_PER_PROFILE) {
    return {
      ok: false,
      error: `a Computers profile can contain at most ${MAX_COMPUTERS_PER_PROFILE} machines`,
      status: 400,
    };
  }
  const eligibleAccountIds = [...new Set([accountId, actorUserId].filter(Boolean) as string[])];
  const owned = await db
    .select({
      tunnelId: tunnelConnections.tunnelId,
      accountId: tunnelConnections.accountId,
    })
    .from(tunnelConnections)
    .where(
      and(
        inArray(tunnelConnections.accountId, eligibleAccountIds),
        inArray(tunnelConnections.tunnelId, tunnelIds),
        isNotNull(tunnelConnections.lastHeartbeatAt),
      ),
    );
  if (owned.length !== tunnelIds.length) {
    return {
      ok: false,
      error:
        'One or more selected computers are no longer available. Refresh the list or pair the computer again.',
      status: 400,
    };
  }
  const tunnelAccountIds = [...new Set(owned.map((row) => row.accountId))];

  const [existing] = await db
    .select({
      connectorId: connectors.connectorId,
      providerType: connectors.providerType,
      name: connectors.name,
      config: connectors.config,
    })
    .from(connectors)
    .where(and(eq(connectors.projectId, projectId), eq(connectors.slug, slug)))
    .limit(1);
  if (existing && existing.providerType !== 'computer') {
    return {
      ok: false,
      error: `Connector slug "${slug}" already exists`,
      status: 409,
    };
  }
  if (existing && draft.create_only === true) {
    return {
      ok: false,
      error: `Connector slug "${slug}" already exists`,
      status: 409,
    };
  }
  const requestedName = typeof draft.name === 'string' ? draft.name.trim() : '';
  const name = requestedName || existing?.name || computerLabel();
  if (name.length > 255) return { ok: false, error: 'name is too long (max 255)', status: 400 };
  await materializeComputerConnectorProfile({
    projectId,
    accountId,
    existingId: existing?.connectorId ?? null,
    spec: computerProfileSpec({
      slug,
      name,
      tunnelIds,
      tunnelAccountIds,
      sensitive: (existing?.config as { sensitive?: unknown } | null)?.sensitive === true,
    }),
  });
  return { ok: true, sync: { synced: 1, errors: [] } };
}

async function deleteComputerConnectorProfile(
  projectId: string,
  slug: string,
): Promise<ConnectorCrudResult | null> {
  const [row] = await db
    .select({
      connectorId: connectors.connectorId,
      providerType: connectors.providerType,
    })
    .from(connectors)
    .where(and(eq(connectors.projectId, projectId), eq(connectors.slug, slug)))
    .limit(1);
  if (!row || row.providerType !== 'computer') return null;
  await db.transaction(async (tx) => {
    await tx
      .delete(projectSessionConnectorBindings)
      .where(eq(projectSessionConnectorBindings.connectorId, row.connectorId));
    await tx.delete(connectors).where(eq(connectors.connectorId, row.connectorId));
  });
  return { ok: true };
}

async function setComputerConnectorName(
  projectId: string,
  accountId: string,
  slug: string,
  name: string,
): Promise<ConnectorCrudResult | null> {
  const connectorId = await computerConnectorId(projectId, accountId, slug);
  if (!connectorId) return null;
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: 'name is required', status: 400 };
  if (trimmed.length > 255) {
    return { ok: false, error: 'name is too long (max 255)', status: 400 };
  }
  await db
    .update(connectors)
    .set({ name: trimmed, updatedAt: new Date() })
    .where(eq(connectors.connectorId, connectorId));
  return { ok: true };
}

export const dbConnectorRouterDeps: ConnectorRouterDeps = {
  attachmentStore: connectorAttachmentStore,
  resolvePrincipal,
  resolveProjectPrincipal,
  makeGatewayDeps: (principal) => makeDbGatewayDeps(principal),
  listCatalog,
  featureFlagEnabled: projectFeatureFlagEnabled,
  resolveAdmin,
  resolveReader,
  resolveSecretReader,
  listConnectors,
  // The manual "Sync" button re-pulls catalogs unconditionally (force) — the
  // user is explicitly asking to refresh, e.g. an MCP server gained new tools.
  syncConnectors: (projectId, accountId) => {
    invalidateProjectMirror(projectId);
    return syncProjectConnectors(projectId, accountId, { force: true });
  },
  createConnector: async (projectId, accountId, draft, actorUserId) =>
    (await upsertComputerConnectorProfile(projectId, accountId, draft, actorUserId)) ??
    upsertConnectorInManifest(projectId, accountId, draft as unknown as ConnectorDraft),
  deleteConnector: async (projectId, slug) =>
    (await deleteComputerConnectorProfile(projectId, slug)) ??
    deleteConnectorFromManifest(projectId, slug),
  setConnectorCredential: (projectId, slug, input) =>
    setConnectorCredentialShared(projectId, slug, input),
  setConnectorSecretBinding,
  resolveSecretBindingAdmin,
  deleteConnectorCredential: async (projectId, slug) => {
    const [row] = await db
      .select({
        connectorId: connectors.connectorId,
        authorizationStrategy: connectors.authorizationStrategy,
      })
      .from(connectors)
      .where(and(eq(connectors.projectId, projectId), eq(connectors.slug, slug)))
      .limit(1);
    if (!row) return { ok: false as const, error: 'connector not found', status: 404 };
    if (row.authorizationStrategy !== 'project') {
      return {
        ok: false as const,
        error: 'Shared credentials require a project authorization strategy',
        status: 409,
      };
    }
    await deleteCredential(row.connectorId, null);
    return { ok: true as const };
  },
  setCredentialMode: (projectId, accountId, slug, mode) =>
    setConnectorCredentialModeInManifest(projectId, accountId, slug, mode),
  setAuthorizationStrategy: (projectId, accountId, slug, authorizationStrategy) =>
    setConnectorAuthorizationStrategyInManifest(projectId, accountId, slug, authorizationStrategy),
  setSensitive: async (projectId, accountId, slug, sensitive) =>
    (await setComputerConnectorSensitive(projectId, accountId, slug, sensitive)) ??
    setConnectorSensitiveInManifest(projectId, accountId, slug, sensitive),
  setConnectorName: async (projectId, accountId, slug, name) =>
    (await setComputerConnectorName(projectId, accountId, slug, name)) ??
    setConnectorNameInManifest(projectId, accountId, slug, name),
  getConnectorPolicies,
  getConnectorConfig,
  setConnectorPolicies: async (projectId, accountId, slug, policies) =>
    (await setComputerConnectorPolicies(projectId, accountId, slug, policies)) ??
    setConnectorPoliciesInManifest(
      projectId,
      accountId,
      slug,
      policies as Parameters<typeof setConnectorPoliciesInManifest>[3],
    ),
  pipedreamConnect: pipedreamConfigured()
    ? async (projectId, slug, _userId, redirects) => {
        const conn = await loadPipedreamConnector(projectId, slug);
        if (!conn || conn.authorizationStrategy !== 'project') return null;
        const { connectUrl, token } = await pipedreamConnectUrl(
          projectId,
          slug,
          conn.app,
          null,
          redirects,
        );
        return { token, app: conn.app, connectUrl };
      }
    : undefined,
  pipedreamFinalize: pipedreamConfigured()
    ? async (projectId, slug, _userId) => {
        const conn = await loadPipedreamConnector(projectId, slug);
        if (!conn || conn.authorizationStrategy !== 'project') return null;
        const r = await finalizePipedreamConnection({
          projectId,
          slug,
          app: conn.app,
          connectorId: conn.connectorId,
          userId: null,
        });
        return { connected: r.connected, accountId: r.accountId };
      }
    : undefined,
  pipedreamWebhook: pipedreamConfigured()
    ? async (extUserId, sig) => {
        if (!verifyWebhookSig(extUserId, sig)) return false;
        const [projectId, slug, identityId] = extUserId.split(':');
        if (!projectId || !slug) return false;
        const conn = await loadPipedreamConnector(projectId, slug);
        if (!conn) return false;
        if (identityId) {
          const [connection] = await db
            .select({
              connectionId: connectorConnections.connectionId,
              ownerType: connectorConnections.ownerType,
              ownerId: connectorConnections.ownerId,
            })
            .from(connectorConnections)
            .where(
              and(
                eq(connectorConnections.connectionId, identityId),
                eq(connectorConnections.projectId, projectId),
                eq(connectorConnections.connectorId, conn.connectorId),
              ),
            )
            .limit(1);
          if (
            connection &&
            connectorAuthorizationMatchesStrategy({
              strategy: conn.authorizationStrategy,
              ownerType: connection.ownerType,
              ownerId: connection.ownerId,
              actingUserId: connection.ownerId ?? '',
              actingPrincipalIsServiceAccount: false,
            })
          ) {
            await finalizePipedreamConnectionAuthorization({
              projectId,
              slug,
              app: conn.app,
              connectorId: conn.connectorId,
              connectionId: connection.connectionId,
              createdBy: null,
            });
            return true;
          }
          return false;
        }
        if (conn.authorizationStrategy !== 'project') return false;
        await finalizePipedreamConnection({
          projectId,
          slug,
          app: conn.app,
          connectorId: conn.connectorId,
          userId: null,
        });
        return true;
      }
    : undefined,
  listPipedreamApps: pipedreamConfigured()
    ? (input) => pipedreamCatalogPage(input)
    : undefined,
  listPipedreamSections: pipedreamConfigured()
    ? (input) => pipedreamCatalogSections(input)
    : undefined,
  discoverConnectorAuth: discoverDraftConnectorAuth,
  listDiscoverConnectors: (input) => listConnectorCatalog(input),
  getDiscoverConnector: (id) => getConnectorCatalogDetail(id),
  getProjectPolicies: getProjectPoliciesFromManifest,
  setProjectPolicies: (projectId, accountId, policies, defaultMode) =>
    setProjectPoliciesInManifest(projectId, accountId, policies, defaultMode),
};
