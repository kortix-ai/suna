/** Connector row reads shared by the DB-backed deps: auth/headers/base URL of a row, its connected state, the active connection, and the policy loaders. */
import {
  connectorPolicies,
  connectorPolicySets,
  connectors,
  connectorProjectPolicies,
  connectorProjectSettings,
} from '@kortix/db';
import { sanitizeConnectorHeaders } from '@kortix/manifest-schema';
import { and, eq, inArray } from 'drizzle-orm';
import {
  hasEmailInboxes,
  loadEmailInboxAccountForInbox,
  loadSlackInstall,
  loadTeamsInstall,
  loadTelegramInstall,
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
  if (platform === 'telegram') return (await loadTelegramInstall(projectId).catch(() => null)) != null;
  if (platform === 'email') return hasEmailInboxes(projectId).catch(() => false);
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
      // An email account is connected while its inbox account is active.
      const account = await loadEmailInboxAccountForInbox(
        row.projectId,
        connection.metadata.inbox_id,
      ).catch(() => null);
      return account?.connectionId === connection.connectionId;
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
    // The caller just loaded this row (`loadConnectorBySlug`); the
    // project-default fallback re-selected it by alias — the duplicated
    // connector read per /call. Thread it; the fallback skips that select.
    connectorRow: row,
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

/** One stored set's rules → `Policy[]`, or null when the stored shape is not
 *  a rule list (read as a missing set: the caller blocks). */
export function policiesOfStoredSet(raw: unknown): Policy[] | null {
  if (!Array.isArray(raw)) return null;
  const out: Policy[] = [];
  for (const [position, rule] of raw.entries()) {
    if (!rule || typeof rule !== 'object') return null;
    const { match, action, conditions } = rule as Record<string, unknown>;
    if (typeof match !== 'string' || (action !== 'always_run' && action !== 'require_approval' && action !== 'block')) {
      return null;
    }
    out.push({ match, action, position, ...parseStoredConditions(conditions) });
  }
  return out;
}

/**
 * A connector's policy set by name. `null` = the connector defines no such set
 * (or its stored rules are unreadable): the gateway blocks (`policy_set_missing`).
 */
export async function loadConnectorPolicySetFor(connectorId: string, name: string): Promise<Policy[] | null> {
  const [row] = await db
    .select({ policies: connectorPolicySets.policies })
    .from(connectorPolicySets)
    .where(and(eq(connectorPolicySets.connectorId, connectorId), eq(connectorPolicySets.name, name)))
    .limit(1);
  return row ? policiesOfStoredSet(row.policies) : null;
}

/** Every set of many connectors: connector id → set name → rules (null = unreadable). */
export async function loadConnectorPolicySetsForMany(
  connectorIds: readonly string[],
): Promise<Map<string, Map<string, Policy[] | null>>> {
  const map = new Map<string, Map<string, Policy[] | null>>();
  if (connectorIds.length === 0) return map;
  const rows = await db
    .select()
    .from(connectorPolicySets)
    .where(inArray(connectorPolicySets.connectorId, connectorIds));
  for (const r of rows) {
    const sets = map.get(r.connectorId) ?? new Map<string, Policy[] | null>();
    sets.set(r.name, policiesOfStoredSet(r.policies));
    map.set(r.connectorId, sets);
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
