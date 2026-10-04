/**
 * Production wiring for the connector router — DB-backed ConnectorRouterDeps +
 * GatewayDeps. Access lives on the connector; credentials are split per (connector,
 * user). The pure logic (gateway/share/execute/policy/normalize) is tested; this
 * is the glue to Postgres + the credential store + Pipedream.
 */
import { connectorConnections, connectors, projectSessions, projects } from '@kortix/db';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { config } from '../lib/config';
import { bindIntegrationPrincipal } from '../services/audit/audit-scope';
import { projectFeatureFlagEnabled } from '../feature-flags/for-project';
import { invalidateProjectMirror } from '../services/git';
import {
  connectionIsReachable,
  type ConnectorConnectOwner,
} from '../projects/lib/connection-access';
import {
  canonicalConnectorAlias,
  listEntitledConnectorConnections,
} from '../services/sessions/session-connector-bindings';
import { db } from '../lib/db';
import { connectorAttachmentStore } from './attachments';
import { notifyConnectorSession } from './notify-session';
import {
  defaultConnectionIdForConnector,
  deleteCredential,
  ensureDefaultConnection,
  ensureMemberConnection,
} from './credentials';
import {
  connectedAsOf,
  relabelToIdentity,
  resolveConnectedAs,
  rowMetadata,
} from './connection-identity';
import {
  type ConnectorDraft,
  deleteConnectorFromManifest,
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
import {
  finalizePipedreamConnection,
  finalizePipedreamConnectionAuthorization,
  pipedreamCatalogPage,
  pipedreamCatalogSections,
  pipedreamConfigured,
  pipedreamConnectUrl,
  verifyWebhookSig,
} from './pipedream';
import type { ConnectorRouterDeps } from './router-contract';
import {
  connectorCatalogSections,
  getConnectorCatalogDetail,
  listConnectorCatalog,
} from './connector-catalog';
import { discoverDraftConnectorAuth, syncProjectConnectors } from './sync';
import {
  createComputerConnector,
  deleteComputerConnectorProfile,
  getConnectorConfig,
  getConnectorPolicies,
  setComputerConnectorName,
  setComputerConnectorPolicies,
  setComputerConnectorSensitive,
  setConnectorSecretBinding,
} from './db-deps-admin';
import { listCatalog, listConnectors } from './db-deps-catalog';
import {
  composioConnectionMetadata,
  composioStableUserId,
  connectLinkEligibility,
  loadComposioAdapter,
  loadComposioConnector,
  loadPipedreamConnector,
  mergeRequestingSession,
  readRequestingSessionId,
} from './db-deps-connect';
import { makeDbGatewayDeps } from './db-deps-gateway';
import {
  resolveAdmin,
  resolveConnectionsManager,
  resolvePrincipal,
  resolveProjectPrincipal,
  resolveReader,
  resolveSecretBindingAdmin,
  resolveSecretReader,
} from './db-deps-principal';
import { connectorConnected } from './db-deps-rows';

export {
  composioConnectionMetadata,
  connectLinkEligibility,
  type ConnectLinkEligibility,
  loadComposioConnector,
  loadPipedreamConnector,
  readRequestingSessionId,
} from './db-deps-connect';
export {
  consumeApprovedExecution,
  isPendingApprovalExecution,
  makeDbGatewayDeps,
} from './db-deps-gateway';
export {
  projectSessionIdForProjectPrincipal,
  resolveTokenBoundSessionId,
  sessionChannelConnectorSlugs,
} from './db-deps-principal';
export {
  composioConnectedAccountId,
  composioConnectionIsNoAuth,
} from './db-deps-rows';

export const dbConnectorRouterDeps: ConnectorRouterDeps = {
  attachmentStore: connectorAttachmentStore,
  resolvePrincipal,
  resolveProjectPrincipal,
  makeGatewayDeps: (principal) => makeDbGatewayDeps(principal),
  listCatalog,
  featureFlagEnabled: projectFeatureFlagEnabled,
  resolveAdmin,
  resolveConnectionsManager,
  resolveReader,
  resolveSecretReader,
  listConnectors,
  // The manual "Sync" button re-pulls catalogs unconditionally (force) — the
  // user is explicitly asking to refresh, e.g. an MCP server gained new tools.
  syncConnectors: (projectId, accountId) => {
    invalidateProjectMirror(projectId);
    return syncProjectConnectors(projectId, accountId, { force: true });
  },
  createConnector: async (projectId, accountId, draft) =>
    (await createComputerConnector(projectId, accountId, draft)) ??
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
      .select({ connectorId: connectors.connectorId })
      .from(connectors)
      .where(and(eq(connectors.projectId, projectId), eq(connectors.slug, slug)))
      .limit(1);
    if (!row) return { ok: false as const, error: 'connector not found', status: 404 };
    // The connector-level strategy gate is gone: the shared credential is a
    // project-wide credential on every connector, and this route already runs
    // behind project.connector.write.
    await deleteCredential(row.connectorId, null);
    return { ok: true as const };
  },
  setCredentialMode: (projectId, accountId, slug, mode) =>
    setConnectorCredentialModeInManifest(projectId, accountId, slug, mode),
  // @deprecated The route above it is an inert no-op; kept wired so the manifest
  // writer stays reachable if an operator ever needs it out of band.
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
        if (!conn) return null;
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
        if (!conn) return null;
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
        const rejected = { ok: false, connected: false } as const;
        if (!verifyWebhookSig(extUserId, sig)) return rejected;
        bindIntegrationPrincipal('pipedream');
        const [projectId, slug, identityId] = extUserId.split(':');
        if (!projectId || !slug) return rejected;
        const conn = await loadPipedreamConnector(projectId, slug);
        if (!conn) return rejected;
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
            connectionIsReachable({
              ownerType: connection.ownerType,
              ownerId: connection.ownerId,
              actingUserId: connection.ownerId ?? '',
              actingPrincipalIsServiceAccount: false,
              // Finishing this row's own authorization is not a use of it.
              audience: 'open',
            })
          ) {
            // Propagate `connected` — a finalize that found no account is NOT
            // an accepted webhook. Swallowing it here is what let every failed
            // finalize look like a success at the route.
            const authorized = await finalizePipedreamConnectionAuthorization({
              projectId,
              slug,
              app: conn.app,
              connectorId: conn.connectorId,
              connectionId: connection.connectionId,
              createdBy: null,
            });
            return { ok: true, connected: authorized.connected };
          }
          return rejected;
        }
        const shared = await finalizePipedreamConnection({
          projectId,
          slug,
          app: conn.app,
          connectorId: conn.connectorId,
          userId: null,
        });
        return { ok: true, connected: shared.connected };
      }
    : undefined,
  listPipedreamApps: pipedreamConfigured() ? (input) => pipedreamCatalogPage(input) : undefined,
  listPipedreamSections: pipedreamConfigured()
    ? (input) => pipedreamCatalogSections(input)
    : undefined,
  connectStatus: async () => {
    const composio = await loadComposioAdapter();
    const providers = [
      ...(composio?.composioConfigured?.() ? ['composio'] : []),
      ...(pipedreamConfigured() ? ['pipedream'] : []),
    ];
    return { configured: providers.length > 0, provider: providers[0] ?? null, providers };
  },
  listConnectToolkits: async (projectId, input) => {
    const composio = await loadComposioAdapter();
    if (composio?.composioConfigured?.() && composio.composioCatalogPage) {
      return composio.composioCatalogPage({ projectId, ...input });
    }
    // `/connect/toolkits` is the Composio surface. Never turn an unavailable
    // Composio deployment into an implicit Pipedream request. The legacy
    // Pipedream catalogue has explicit `/pipedream/apps` routes for deliberate
    // rollback use.
    return null;
  },
  listConnectSections: async (_projectId, input) => {
    const composio = await loadComposioAdapter();
    if (composio?.composioConfigured?.() && composio.composioCatalogSections) {
      return composio.composioCatalogSections(input);
    }
    // Same rule as `/connect/toolkits`: no silent Pipedream fallback.
    return null;
  },
  listSessionConnectRequests: async (projectId, sessionId) => {
    const rows = await db
      .select({
        connector: connectors,
        connectionId: connectorConnections.connectionId,
        isDefault: connectorConnections.isDefault,
        metadata: connectorConnections.metadata,
      })
      .from(connectorConnections)
      .innerJoin(connectors, eq(connectors.connectorId, connectorConnections.connectorId))
      .where(
        and(
          eq(connectorConnections.projectId, projectId),
          sql`${connectorConnections.metadata}->>'requesting_session_id' = ${sessionId}`,
        ),
      );
    const out: Array<{ slug: string; app: string; provider: string; connected: boolean }> = [];
    for (const row of rows) {
      const metadata = (row.metadata ?? {}) as Record<string, unknown>;
      const connected = await connectorConnected(row.connector, null, {
        connectionId: row.connectionId,
        isDefault: row.isDefault,
        metadata,
      });
      out.push({
        slug: row.connector.slug,
        app:
          typeof metadata.toolkit === 'string'
            ? metadata.toolkit
            : ((row.connector.config as Record<string, unknown> | null)?.app as string) ??
              row.connector.slug,
        provider: row.connector.providerType,
        connected,
      });
    }
    return out;
  },
  listConnectorAccounts: async ({ projectId, slug, userId, sessionId, agentPrincipal }) => {
    const [session] = sessionId
      ? await db
          .select({ visibility: projectSessions.visibility })
          .from(projectSessions)
          .where(eq(projectSessions.sessionId, sessionId))
          .limit(1)
      : [];
    const [project] = await db
      .select({ accountId: projects.accountId })
      .from(projects)
      .where(eq(projects.projectId, projectId))
      .limit(1);
    if (!project) return [];
    const entitled = await listEntitledConnectorConnections({
      accountId: project.accountId,
      projectId,
      alias: canonicalConnectorAlias(slug),
      actingUserId: userId,
      // An agent-principal credential with no session is never `private`.
      visibility: session?.visibility ?? (agentPrincipal ? 'project' : 'private'),
      agentPrincipal: agentPrincipal ?? null,
    });
    return entitled.map((connection) => ({
      connection_id: connection.connectionId,
      label: connection.label,
      owner_type: connection.ownerType,
      is_default: connection.isDefault,
      connected_as: connectedAsOf(connection.metadata),
    }));
  },
  mintConnectorConnectLink: async ({ projectId, slug, userId, sessionId }) => {
    const eligibility = await connectLinkEligibility(projectId, canonicalConnectorAlias(slug));
    // No hosted page (raw http/mcp/graphql connector, or no provider app bound)
    // means no link exists to hand over. The denial still names the connector.
    if (!eligibility.ok) return null;
    const composio = await loadComposioAdapter();
    if (!(composio?.composioConfigured?.() ?? false) && !pipedreamConfigured()) return null;
    // The denial's remedy is always "authorize YOURSELF": the human reading it
    // is the one who can, and a shared account is a deliberate admin choice made
    // from settings. A link with no member behind it would resolve to nobody.
    if (!userId) return null;
    const { mintSetupLink } = await import('../setup-links/token');
    const { token } = mintSetupLink(projectId, {
      kind: 'connector',
      slug: canonicalConnectorAlias(slug),
      app: eligibility.app,
      uid: userId,
      sid: sessionId,
      owner: 'me',
    });
    return `${(config.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '')}/connect/${token}`;
  },
  connectorConnect: async (projectId, slug, userId, redirects, requestingSessionId, owner) => {
    const connectOwner: ConnectorConnectOwner = owner ?? 'me';
    const conn = await loadComposioConnector(projectId, slug);
    if (conn) {
      const composio = await loadComposioAdapter();
      if (!composio?.composioConfigured?.()) return null;
      // WHICH connection this authorization lands on is the CALLER's explicit
      // choice, not a property of the connector:
      //
      // `me`      → the caller's own member connection.
      // `project` → the canonical project-default connection sync already
      //             created. Reuse it rather than inserting a second row, which
      //             violates idx_connector_connections_default_project.
      //
      // The `me` branch used to `return null` for any connector whose strategy
      // was not `user`, which is why a private account had no connect flow
      // anywhere in the product: no link could be minted, so the session card
      // had nothing to offer and the user was simply stuck.
      if (connectOwner === 'me' && !userId) return null;
      const connectionId =
        connectOwner === 'me'
          ? await ensureMemberConnection({
              projectId,
              connectorId: conn.connectorId,
              userId,
            })
          : await ensureDefaultConnection({
              projectId,
              connectorId: conn.connectorId,
            });
      const [previousRow] = await db
        .select({ metadata: connectorConnections.metadata })
        .from(connectorConnections)
        .where(eq(connectorConnections.connectionId, connectionId))
        .limit(1);
      const previous = (previousRow?.metadata ?? {}) as Record<string, unknown>;
      await db
        .update(connectorConnections)
        .set({
          status: 'active',
          // INVARIANT (2026-09-16, account_required rule): never set is_default
          // here — an auto-authorized account is not a deliberately pinned one.
          // `connectorFinalize` below finds this row back by recency
          // (`updatedAt`), not by `is_default`, so dropping this never breaks
          // the handshake.
          // Clear any previous account binding before authorization starts.
          // Pending rows stay active because the DB enum has no needs_auth
          // value. The gateway still fails closed on missing auth metadata.
          metadata: {
            ...rowMetadata(previous),
            provider: 'composio',
            toolkit: conn.app,
            requesting_session_id: requestingSessionId ?? null,
          },
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(connectorConnections.accountId, conn.accountId),
            eq(connectorConnections.projectId, projectId),
            eq(connectorConnections.connectorId, conn.connectorId),
            eq(connectorConnections.connectionId, connectionId),
          ),
        );
      const stableUserId = composioStableUserId(connectionId);
      const result = await composio.composioConnectUrl({
        projectId,
        slug,
        app: conn.app,
        connectionId,
        stableUserId,
        redirects,
      });
      await db
        .update(connectorConnections)
        .set({
          status: 'active',
          metadata: composioConnectionMetadata({
            toolkit: conn.app,
            stableUserId,
            sessionId: result.sessionId,
            authRequestId: result.authRequestId,
            connectedAccountId: result.connectedAccountId,
            isNoAuth: result.isNoAuth,
            requestingSessionId,
            previous,
            // An already-active account kept its identity. A new authorization
            // has none until finalize probes it.
            connectedAs:
              result.connectedAccountId &&
              result.connectedAccountId === previous.connected_account_id
                ? connectedAsOf(previous)
                : null,
          }),
          updatedAt: sql`now()`,
        })
        .where(and(
          eq(connectorConnections.accountId, conn.accountId),
          eq(connectorConnections.projectId, projectId),
          eq(connectorConnections.connectorId, conn.connectorId),
          eq(connectorConnections.connectionId, connectionId),
        ));
      return {
        provider: 'composio',
        app: conn.app,
        connectUrl: result.connectUrl,
        requestId: result.authRequestId,
        sessionId: result.sessionId,
        connectionId,
        connected: result.connected,
        isNoAuth: result.isNoAuth,
      };
    }
    if (!pipedreamConfigured()) return null;
    const pipedream = await loadPipedreamConnector(projectId, slug);
    if (!pipedream) return null;
    // Legacy Pipedream path: its hosted flow only ever authorized the ONE shared
    // project account (`pipedreamConnectUrl(..., null)` — no external user id).
    // A private account there needs a per-member external id, which this path
    // has never minted, so `me` is refused rather than silently answered with
    // the shared account.
    if (connectOwner === 'me') return null;
    const { connectUrl, token } = await pipedreamConnectUrl(projectId, slug, pipedream.app, null, redirects);
    await mergeRequestingSession(
      await ensureDefaultConnection({ projectId, connectorId: pipedream.connectorId }),
      requestingSessionId,
    );
    return { provider: 'pipedream', token, app: pipedream.app, connectUrl };
  },
  connectorFinalize: async (projectId, slug, _userId, selector, owner) => {
    const finalizeOwner: ConnectorConnectOwner = owner ?? 'me';
    const conn = await loadComposioConnector(projectId, slug);
    if (conn) {
      // Finalize the connection the START created, so it honors the owner the
      // link recorded. Hard-requiring a project-owned row here is what made a
      // completed private authorization resolve to nothing.
      if (finalizeOwner === 'me' && !_userId) return null;
      const composio = await loadComposioAdapter();
      if (!composio?.composioConfigured?.()) return null;
      const [connection] = await db
        .select({ connectionId: connectorConnections.connectionId, metadata: connectorConnections.metadata })
        .from(connectorConnections)
        .where(
          and(
            eq(connectorConnections.accountId, conn.accountId),
            eq(connectorConnections.projectId, projectId),
            eq(connectorConnections.connectorId, conn.connectorId),
            finalizeOwner === 'me'
              ? and(
                  eq(connectorConnections.ownerType, 'member'),
                  eq(connectorConnections.ownerId, _userId ?? ''),
                )
              : and(
                  eq(connectorConnections.ownerType, 'project'),
                  isNull(connectorConnections.ownerId),
                ),
            ...(selector?.connectionId
              ? [eq(connectorConnections.connectionId, selector.connectionId)]
              : []),
          ),
        )
        // No explicit connectionId: find the connection the matching `connect`
        // call just started. INVARIANT (2026-09-16, account_required rule):
        // that row is never marked `is_default` (a Composio authorization is
        // never a deliberate pin), so this can no longer key off `is_default` —
        // `connectorConnect`'s two updates both touch `updatedAt`, so the most
        // recently touched row in this owner scope IS the one just started.
        .orderBy(desc(connectorConnections.updatedAt))
        .limit(1);
      if (selector?.connectionId && !connection) throw new HTTPException(404, { message: 'connector connection not found' });
      if (!connection) return { provider: 'composio', connected: false };
      const metadata = (connection.metadata ?? {}) as Record<string, unknown>;
      const sessionId = typeof metadata.session_id === 'string' ? metadata.session_id : '';
      const authRequestId = typeof metadata.auth_request_id === 'string' ? metadata.auth_request_id : undefined;
      const expectedConnectedAccountId = typeof metadata.connected_account_id === 'string' ? metadata.connected_account_id : undefined;
      const requestingSessionId = readRequestingSessionId(metadata);
      if (selector?.requestId && selector.requestId !== authRequestId) {
        throw new HTTPException(409, { message: 'authorization request does not match connection' });
      }
      if (!sessionId) return { provider: 'composio', connected: false, connectionId: connection.connectionId };
      const stableUserId = composioStableUserId(connection.connectionId);
      const result = await composio.finalizeComposioConnection({
        projectId,
        slug,
        app: conn.app,
        connectionId: connection.connectionId,
        stableUserId,
        sessionId,
        authRequestId,
        expectedConnectedAccountId,
      });
      const connectedAccountId = result.connectedAccountId ?? expectedConnectedAccountId;
      const connectedAs = result.connected
        ? await resolveConnectedAs({
            previous: metadata,
            connectedAccountId,
            isNoAuth: result.isNoAuth,
            probe: () =>
              composio.probeComposioIdentity
                ? composio.probeComposioIdentity({
                    app: conn.app,
                    sessionId: result.sessionId,
                    connectedAccountId: connectedAccountId!,
                  })
                : Promise.resolve(null),
          })
        : null;
      await db
        .update(connectorConnections)
        .set({
          // An incomplete authorization is a retryable needs-auth state. The
          // gateway derives it from metadata and rejects execution until an
          // account id exists or the toolkit is explicitly no-auth.
          status: 'active',
          metadata: composioConnectionMetadata({
            toolkit: conn.app,
            stableUserId,
            sessionId: result.sessionId,
            authRequestId: result.authRequestId ?? authRequestId,
            connectedAccountId,
            isNoAuth: result.isNoAuth,
            requestingSessionId,
            previous: metadata,
            connectedAs,
          }),
          updatedAt: sql`now()`,
        })
        .where(and(
          eq(connectorConnections.accountId, conn.accountId),
          eq(connectorConnections.projectId, projectId),
          eq(connectorConnections.connectorId, conn.connectorId),
          eq(connectorConnections.connectionId, connection.connectionId),
        ));
      // The agent that minted the link is blocked waiting on this. Tell it the
      // account landed so it resumes instead of posting a second link next run.
      // Fire-and-forget: the credential is already saved, and a notification
      // failure must never turn a successful connect into an error.
      // A generic default label ("Private connection", the connector name)
      // becomes the identity, so the account list shows WHO each row is.
      const label = connectedAs
        ? await relabelToIdentity({ connectionId: connection.connectionId, identity: connectedAs })
        : null;
      if (result.connected && requestingSessionId) {
        void notifyConnectorSession(requestingSessionId, projectId, _userId ?? null, slug, conn.app);
      }
      return {
        provider: 'composio',
        connected: result.connected,
        accountId: result.connectedAccountId,
        connectionId: connection.connectionId,
        isNoAuth: result.isNoAuth,
        connectedAs,
        ...(label ? { label } : {}),
      };
    }
    if (!pipedreamConfigured()) return null;
    const pipedream = await loadPipedreamConnector(projectId, slug);
    if (!pipedream) return null;
    // Mirrors `connectorConnect`: the legacy Pipedream hosted flow only ever
    // authorized the shared project account.
    if (finalizeOwner === 'me') return null;
    const r = await finalizePipedreamConnection({
      projectId,
      slug,
      app: pipedream.app,
      connectorId: pipedream.connectorId,
      userId: null,
    });
    if (r.connected) {
      // INVARIANT (2026-09-16, account_required rule): the row `connectorConnect`
      // primed via `ensureDefaultConnection` is never marked `is_default`
      // itself — `defaultConnectionIdForConnector` still finds it (pinned, or
      // the connector's sole project row), which is exactly the resolution the
      // legacy Pipedream hosted flow (project-account-only) needs here.
      const defaultConnectionId = await defaultConnectionIdForConnector(pipedream.connectorId);
      const [row] = defaultConnectionId
        ? await db
            .select({ metadata: connectorConnections.metadata })
            .from(connectorConnections)
            .where(eq(connectorConnections.connectionId, defaultConnectionId))
            .limit(1)
        : [];
      const waiting = readRequestingSessionId(row?.metadata);
      if (waiting) void notifyConnectorSession(waiting, projectId, _userId ?? null, slug, pipedream.app);
    }
    return { provider: 'pipedream', connected: r.connected, accountId: r.accountId };
  },
  discoverConnectorAuth: discoverDraftConnectorAuth,
  listDiscoverConnectors: (input) => listConnectorCatalog(input),
  listDiscoverSections: (input) => connectorCatalogSections(input),
  getDiscoverConnector: (id) => getConnectorCatalogDetail(id),
  getProjectPolicies: getProjectPoliciesFromManifest,
  setProjectPolicies: (projectId, accountId, policies, defaultMode) =>
    setProjectPoliciesInManifest(projectId, accountId, policies, defaultMode),
};
