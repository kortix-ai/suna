/** Connector row reads shared by the DB-backed deps: auth/headers/base URL of a row, its connected state, the active connection, and the policy loaders. */
import {
  connectorPolicies,
  connectors,
  connectorProjectPolicies,
  connectorProjectSettings,
} from '@kortix/db';
import { sanitizeConnectorHeaders } from '@kortix/manifest-schema';
import { eq, inArray } from 'drizzle-orm';
import {
  loadAgentMailInstall,
  loadSlackInstall,
  loadTeamsInstall,
} from '../channels/install-store';
import { resolveSessionConnectorConnection } from '../projects/lib/session-connector-bindings';
import { db } from '../shared/db';
import {
  connectionIsEffectiveProjectDefault,
  credentialExists,
  connectionCredentialExists,
} from './credentials';
import type { ConnectorAuth } from './call';
import { type DefaultMode, type Policy, parseStoredConditions } from './policy';
import type { ConnectorPrincipal } from './router-contract';

const DEFAULT_AUTH: ConnectorAuth = {
  type: 'none',
  in: 'header',
  name: null,
  prefix: null,
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_REGEX.test(value);
}

export type ConnectorRow = typeof connectors.$inferSelect;

export function authOf(row: ConnectorRow): { auth: ConnectorAuth; hasAuth: boolean } {
  const cfg = (row.config ?? {}) as Record<string, any>;
  const auth: ConnectorAuth = cfg.auth
    ? {
        type: cfg.auth.type,
        in: cfg.auth.in ?? 'header',
        name: cfg.auth.name ?? null,
        prefix: cfg.auth.prefix ?? null,
      }
    : DEFAULT_AUTH;
  const hasAuth = row.providerType === 'pipedream' || row.providerType === 'composio' || auth.type !== 'none';
  return { auth, hasAuth };
}

function metadataString(metadata: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function composioConnectionIsNoAuth(metadata: Record<string, unknown> | null | undefined): boolean {
  return metadata?.provider === 'composio' && metadata.is_no_auth === true;
}

export function composioConnectedAccountId(metadata: Record<string, unknown> | null | undefined): string | null {
  return metadata?.provider === 'composio' ? metadataString(metadata, 'connected_account_id') : null;
}

/**
 * The connector's static request headers (kortix.yaml `headers:`, persisted
 * into `config` by the materializer). Sanitized on the way out — a row written
 * before the header rules existed can never inject an illegal header.
 */
export function headersOf(row: ConnectorRow): Record<string, string> {
  const cfg = (row.config ?? {}) as Record<string, any>;
  return sanitizeConnectorHeaders(cfg.headers);
}

export function baseUrlOf(row: ConnectorRow): string | null {
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
export function channelPlatform(config: ConnectorRow['config'] | null): string | null {
  return (config as Record<string, any> | null)?.platform ?? null;
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
export async function connectorConnected(
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
  if (row.providerType === 'composio') {
    return composioConnectionIsNoAuth(connection?.metadata) || composioConnectedAccountId(connection?.metadata) !== null;
  }
  if (!connection) return credentialExists(row.connectorId, userId);
  if (
    await connectionCredentialExists({ connectorId: row.connectorId, connectionId: connection.connectionId })
  ) {
    return true;
  }
  // `connection.isDefault` covers a PINNED default of any owner type (kept as
  // before). INVARIANT (2026-09-16, account_required rule): a project-owned
  // connection with nothing pinned ALSO inherits the legacy connector-level
  // credential when it is the connector's sole active project-owned row — see
  // `defaultConnectionIdForConnector`. A project connector with one shared
  // account keeps working exactly as before this change.
  const inheritsLegacyCredential =
    connection.isDefault ||
    (await connectionIsEffectiveProjectDefault(row.connectorId, connection.connectionId));
  return inheritsLegacyCredential && (await credentialExists(row.connectorId, userId));
}

/**
 * Resolve the one active connection this principal may use.
 *
 * Catalog discovery and call execution must use this same function. A session
 * with an explicit fail-closed scope cannot advertise a project-default connection
 * in the catalog and then lose it when the gateway resolves the call.
 */
export async function resolveActiveConnectorConnection(principal: ConnectorPrincipal, row: ConnectorRow) {
  const connection = await resolveSessionConnectorConnection({
    accountId: principal.accountId,
    projectId: row.projectId,
    sessionId: principal.sessionId,
    alias: row.slug,
    actingUserId: principal.userId,
    account: principal.requestedConnectorAccount ?? null,
    agentPrincipal: principal.agentPrincipal ?? null,
  });
  return connection?.status === 'active' ? connection : null;
}

export async function loadConnectorPoliciesFor(connectorId: string): Promise<Policy[]> {
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

/** `loadConnectorPoliciesFor`, batched over many connectors in one query
 *  instead of one `eq(connectorId, ...)` select per connector. */
export async function loadConnectorPoliciesForMany(
  connectorIds: readonly string[],
): Promise<Map<string, Policy[]>> {
  const map = new Map<string, Policy[]>();
  if (connectorIds.length === 0) return map;
  const rows = await db
    .select()
    .from(connectorPolicies)
    .where(inArray(connectorPolicies.connectorId, connectorIds));
  for (const r of rows) {
    const policy: Policy = {
      match: r.match,
      action: r.action,
      position: r.position,
      ...parseStoredConditions(r.conditions),
    };
    const list = map.get(r.connectorId);
    if (list) list.push(policy);
    else map.set(r.connectorId, [policy]);
  }
  return map;
}

export async function loadProjectPoliciesFor(projectId: string): Promise<Policy[]> {
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

export async function loadDefaultModeFor(projectId: string): Promise<DefaultMode> {
  const [row] = await db
    .select({ defaultMode: connectorProjectSettings.defaultMode })
    .from(connectorProjectSettings)
    .where(eq(connectorProjectSettings.projectId, projectId))
    .limit(1);
  return (row?.defaultMode as DefaultMode) ?? 'allow_all';
}
