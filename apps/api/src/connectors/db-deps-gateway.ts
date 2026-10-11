/** DB-backed GatewayDeps for one principal (makeDbGatewayDeps) and the approval carry-over reads it uses. */
import { connectorConnections, connectorActions, connectors, connectorCalls } from '@kortix/db';
import { appAuthorizationForConnectorCall } from '../apps/connector-assertion';
import { and, desc, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm';
import { resolveAgentMailApiKey } from '../channels/agentmail-api';
import { bindSlackThreadToSession } from '../channels/slack/binding';
import { slackUserNames } from '../channels/slack/labels';
import {
  loadAgentMailApiKeyForInbox,
  loadAgentMailApiKeyForProject,
  loadAgentMailInstall,
  loadSlackTeamIdForProject,
  loadSlackTokenForProject,
  loadTeamsBotCredentials,
  loadTeamsTenantForProject,
} from '../channels/install-store';
import { approvalPageUrl } from '../setup-links/token';
import { config } from '../config';
import type { ConnectionOwnerType } from '../projects/lib/connection-access';
import {
  getProjectSecretConsumerConfigurationStatus,
  getProjectSecretValueForConsumer,
} from '../projects/secrets';
import {
  canonicalConnectorAlias,
  resolveSessionConnectorConnectionOutcome,
} from '../projects/lib/session-connector-bindings';
import { db } from '../shared/db';
import { executeComputerCall } from '../tunnel/core/rpc-core';
import { connectorAttachmentStore } from './attachments';
import { gateChannelRead } from './channel-read-scope';
import { gateChannelWrite } from './channel-write-scope';
import { resolveCredentialValue, resolveConnectionCredentialValue } from './credentials';
import { connectorEgressFetch } from './egress';
import { CredentialNotSharedError } from './gateway';
import type { GatewayAction, GatewayConnector, GatewayDeps } from './gateway';
import { graphToken } from '../channels/teams-auth';
import { runPipedreamAction, runPipedreamProxy } from './pipedream';
import type { ConnectorPrincipal } from './router-contract';
import { COMPUTER_SLUG, withComputerCatalog } from './computers';
import { ensureProjectComputer } from './sync';
import type { ActionBinding, Risk } from './types';
import {
  type ConnectorRow,
  authOf,
  baseUrlOf,
  channelPlatform,
  composioConnectedAccountId,
  composioConnectionIsNoAuth,
  headersOf,
  isUuid,
  loadConnectorPoliciesFor,
  loadDefaultModeFor,
  loadProjectPoliciesFor,
  resolveActiveConnectorConnection,
} from './db-deps-rows';

/** How long an unconsumed human approve stays claimable by a fresh call. Long
 *  enough for the "agent gave up → approve lands → nudge/`continue` retries"
 *  round-trip, short enough that a stale yes can't silently authorize a much
 *  later call. */
const APPROVAL_CARRYOVER_WINDOW_MS = 15 * 60 * 1000;

/**
 * The call path reads connector/project policies and the project's default
 * mode on EVERY /call — through these loaders directly. A TTL memo here
 * (measured: warm calls saved ~5 statements) was reverted: the flow suite
 * pins that a policy row seeded or edited between two calls is enforced by
 * the very next call (CONN-32), and no TTL can honor that without an
 * invalidation hook the raw-SQL seeds and the admin routes don't share.
 * The bounded per-call statement count this issue promises comes from the
 * stored-grant hint, the single git-project read and the single manifest
 * load — not from caching policy rows.
 */

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

function toGatewayConnector(
  row: ConnectorRow,
  connection?: {
    connectionId: string;
    isDefault: boolean;
    metadata: Record<string, unknown>;
    // Optional: only `resolveActiveConnectorConnection` (session-scoped calls)
    // carries these. Other callers (catalog/discovery paths) pass connections
    // without them and the gateway simply has no account to echo.
    label?: string;
    ownerType?: ConnectionOwnerType;
  } | null,
): GatewayConnector {
  const { auth, hasAuth: configuredHasAuth } = authOf(row);
  const hasAuth = row.providerType === 'composio'
    ? !composioConnectionIsNoAuth(connection?.metadata)
    : configuredHasAuth;
  return {
    connectorId: row.connectorId,
    authSecret: row.authSecret,
    connectionId: connection?.connectionId ?? null,
    connectionIsDefault: connection?.isDefault ?? false,
    connectionMetadata: connection?.metadata ?? {},
    connectionLabel: connection?.label ?? null,
    connectionOwnerType: connection?.ownerType ?? null,
    slug: row.slug,
    provider: row.providerType,
    platform: channelPlatform(row.config),
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

export function makeDbGatewayDeps(principal: ConnectorPrincipal): GatewayDeps {
  return {
    attachmentStore: connectorAttachmentStore,
    // Spec 2026-09-22 §2.5: an agent session calling a same-project Kortix App.
    appAuthorizationFor: (input) => appAuthorizationForConnectorCall(input),
    loadConnectorBySlug: async (projectId, slug) => {
      if (canonicalConnectorAlias(slug) === COMPUTER_SLUG) {
        await ensureProjectComputer(projectId, principal.userId);
      }
      const [row] = await db
        .select()
        .from(connectors)
        .where(and(eq(connectors.projectId, projectId), eq(connectors.slug, slug)))
        .limit(1);
      if (!row) return null;
      const connection = await resolveActiveConnectorConnection(principal, row);
      if (!connection) return null;
      const connector = toGatewayConnector(row, connection);
      if (row.providerType === 'computer') {
        const [machine] = await db
          .select({ tunnelId: connectorConnections.tunnelId })
          .from(connectorConnections)
          .where(eq(connectorConnections.connectionId, connection.connectionId))
          .limit(1);
        connector.connectionTunnelId = machine?.tunnelId ?? null;
      }
      return connector;
    },
    selectComputerAccount: async (projectId, slug, selector) => {
      const [row] = await db
        .select({ connectorId: connectors.connectorId, providerType: connectors.providerType })
        .from(connectors)
        .where(and(eq(connectors.projectId, projectId), eq(connectors.slug, slug)))
        .limit(1);
      if (row?.providerType !== 'computer') return 'not_computer';
      const name = typeof selector === 'string' ? selector.trim() : '';
      if (!name) return null;
      // A tunnel id names the machine; its account ids go first. The name
      // itself is tried last as an account label or connection id.
      const byMachine = isUuid(name)
        ? await db
            .select({ connectionId: connectorConnections.connectionId })
            .from(connectorConnections)
            .where(
              and(
                eq(connectorConnections.connectorId, row.connectorId),
                eq(connectorConnections.tunnelId, name),
                eq(connectorConnections.status, 'active'),
              ),
            )
        : [];
      const named = principal.requestedConnectorAccount
        ? await makeDbGatewayDeps(principal).loadConnectorBySlug(projectId, slug)
        : null;
      for (const account of [...byMachine.map((match) => match.connectionId), name]) {
        const selected = await makeDbGatewayDeps({
          ...principal,
          requestedConnectorAccount: account,
        }).loadConnectorBySlug(projectId, slug);
        if (!selected) continue;
        // --account and the legacy argument must agree.
        if (principal.requestedConnectorAccount && named?.connectionId !== selected.connectionId) {
          return null;
        }
        return selected;
      }
      return null;
    },
    explainMissingConnector: async (projectId, slug) => {
      const [row] = await db
        .select({
          connectorId: connectors.connectorId,
          enabled: connectors.enabled,
          status: connectors.status,
          providerType: connectors.providerType,
        })
        .from(connectors)
        .where(and(eq(connectors.projectId, projectId), eq(connectors.slug, slug)))
        .limit(1);
      if (!row) return 'connector_not_found';
      if (!row.enabled || row.status === 'disabled') return 'connector_disabled';
      // Re-run the SAME resolution `loadConnectorBySlug` just failed (session
      // binding, visibility, explicit-only gate — all of it), to learn WHY:
      // `ambiguous` (several reachable accounts, none named or pinned) is
      // `account_required`, a denial the caller can fix by naming one. Every
      // other `none` outcome keeps the original `connector_not_connected`.
      const outcome = await resolveSessionConnectorConnectionOutcome({
        accountId: principal.accountId,
        projectId,
        sessionId: principal.sessionId,
        alias: slug,
        actingUserId: principal.userId,
        account: principal.requestedConnectorAccount ?? null,
        agentPrincipal: principal.agentPrincipal ?? null,
      });
      if (outcome.kind === 'ambiguous') return 'account_required';
      // Unpairing revokes the machine's accounts and nulls their tunnel_id
      // (DELETE /tunnel/connections/:id). The caller's own such account, or the
      // one they named, says why: the computer is gone, not unconnected.
      if (row.providerType === 'computer') {
        const named = principal.requestedConnectorAccount?.trim();
        const [unpaired] = await db
          .select({ connectionId: connectorConnections.connectionId })
          .from(connectorConnections)
          .where(
            and(
              eq(connectorConnections.connectorId, row.connectorId),
              eq(connectorConnections.status, 'revoked'),
              isNull(connectorConnections.tunnelId),
              eq(connectorConnections.ownerType, 'member'),
              eq(connectorConnections.ownerId, principal.userId),
              named ? eq(connectorConnections.label, named) : undefined,
            ),
          )
          .limit(1);
        if (unpaired) return 'computer_unpaired';
      }
      return 'connector_not_connected';
    },
    loadAction: async (connectorId, relPath, providerType) => {
      // The call path already holds the connector row (it loaded it to
      // authorize the call) and passes its provider.
      const [stored] = await db
        .select()
        .from(connectorActions)
        .where(
          and(eq(connectorActions.connectorId, connectorId), eq(connectorActions.path, relPath)),
        )
        .limit(1);
      const a =
        providerType === 'computer'
          ? withComputerCatalog(connectorId, 'computer', []).find((row) => row.path === relPath)
          : stored;
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
      if (connector.provider === 'composio') {
        return composioConnectedAccountId(connector.connectionMetadata);
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
      const value = await getProjectSecretValueForConsumer({
        projectId: principal.projectId,
        accountId: principal.accountId,
        sessionId: principal.sessionId,
        actorUserId: principal.userId,
        name: connector.authSecret,
        consumer: 'connector',
      });
      if (value !== null) return value;
      // A configured secret that resolved to nothing for this caller is one
      // narrowed to an audience they are outside of.
      const status = await getProjectSecretConsumerConfigurationStatus({
        projectId: principal.projectId,
        name: connector.authSecret,
        consumer: 'connector',
      });
      if (status === 'configured') throw new CredentialNotSharedError(connector.authSecret);
      return null;
    },
    // Session metadata is user-writable, so it is not a trusted routing source
    // for inbox, thread, or message identifiers. A future channel-owned binding
    // may provide this context; until then callers must pass explicit action args.
    bindSlackThread: (input) => bindSlackThreadToSession(input),
    // ponytail: 25 distinct authors per read; a longer thread keeps ids past it.
    nameSlackUsers: async ({ projectId, token, userIds }) =>
      slackUserNames(
        token,
        (await loadSlackTeamIdForProject(projectId).catch(() => null)) ?? `project:${projectId}`,
        userIds,
        25,
      ),
    gateChannelRead: (input) => gateChannelRead(input),
    gateChannelWrite: (input) => gateChannelWrite(input),
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
    // Lazy: channels import connectors, so a static import here would cycle.
    postApprovalCard: async (input) =>
      (await import('../channels/approval-card-relay')).postApprovalCard(input),
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
    // Computer connectors relay to the resolved account's machine through the
    // shared tunnel RPC core (wire permission → relay → audit).
    executeComputerCall,
    // Every connector request resolves and checks its target, on each
    // redirect hop too. See egress.ts.
    fetchImpl: connectorEgressFetch,
    enforcePolicies: true,
  };
}
