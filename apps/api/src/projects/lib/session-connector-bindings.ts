import {
  type RequiredConnectorConnection,
  type SessionConnectorBindings,
  SessionConnectorBindingsInputSchema,
} from '@kortix/api-contract';
import {
  connectorConnections,
  connectors,
  projectSessionConnectorBindings,
  projectSessions,
  serviceAccounts,
} from '@kortix/db';
import { and, desc, eq } from 'drizzle-orm';
import {
  canonicalConnectorAlias,
  publicConnectorAlias,
} from '../../shared/connector-alias';
import {
  loadAgentMailInstall,
  loadSlackInstall,
  loadTeamsInstall,
} from '../../channels/install-store';
import {
  credentialExists,
  connectionCredentialExists,
} from '../../connectors/credentials';
import { db } from '../../shared/db';
import { isUniqueViolation } from '../../shared/postgres-errors';
import {
  connectorAuthorizationMatchesStrategy,
  isTrustedManagedChannelAuthorization,
  type ConnectorAuthorizationStrategy,
} from './connector-authorization-strategy';
import { projectSecretIsConfiguredForConsumer } from '../secrets';

export interface ValidatedSessionConnectorBinding {
  alias: string;
  connectionId: string;
  connectorId: string;
  ownerType: 'project' | 'agent' | 'member' | 'subject' | 'external';
  ownerId: string | null;
  authorizationStrategy: ConnectorAuthorizationStrategy;
}

export interface ResolvedSessionConnectorConnection {
  connectionId: string;
  connectorId: string;
  alias: string;
  status: 'active' | 'revoked' | 'error';
  isDefault: boolean;
  metadata: Record<string, unknown>;
  source: 'request' | 'default';
}

interface ConnectorRequirementRow {
  connectorId: string;
  projectId: string;
  slug: string;
  name: string;
  providerType: string;
  config: Record<string, unknown>;
  authorizationStrategy: ConnectorAuthorizationStrategy;
  enabled: boolean;
  status: 'active' | 'disabled' | 'needs_auth' | 'error';
}

interface ConnectorConnectionRow {
  connectionId: string;
  isDefault: boolean;
  ownerType: 'project' | 'agent' | 'member' | 'subject' | 'external';
  ownerId: string | null;
  status: 'active' | 'revoked' | 'error';
  metadata: Record<string, unknown>;
}

function connectorPlatform(config: Record<string, unknown>): string | null {
  return typeof config.platform === 'string' ? config.platform : null;
}

function connectorRequiresAuthorization(connector: ConnectorRequirementRow): boolean {
  if (connector.providerType === 'pipedream' || connector.providerType === 'channel') return true;
  const auth = connector.config.auth;
  if (!auth || typeof auth !== 'object') return false;
  return (auth as Record<string, unknown>).type !== 'none';
}

export async function connectorConnectionIsConnected(input: {
  connector: ConnectorRequirementRow;
  connection: ConnectorConnectionRow;
}): Promise<boolean> {
  const { connector, connection } = input;
  if (!connectorRequiresAuthorization(connector)) return true;
  if (connector.providerType === 'channel') {
    const platform = connectorPlatform(connector.config);
    const connectionSlug =
      typeof connection.metadata.connector_slug === 'string'
        ? connection.metadata.connector_slug
        : connector.slug;
    if (platform === 'slack') {
      return (await loadSlackInstall(connector.projectId).catch(() => null)) !== null;
    }
    if (platform === 'teams') {
      return (await loadTeamsInstall(connector.projectId).catch(() => null)) !== null;
    }
    if (platform === 'email') {
      const install = await loadAgentMailInstall(connector.projectId, connectionSlug).catch(
        () => null,
      );
      if (!install) return false;
      return (
        typeof connection.metadata.inbox_id !== 'string' ||
        install.inboxId === connection.metadata.inbox_id
      );
    }
    return false;
  }
  if (
    await connectionCredentialExists({
      connectorId: connector.connectorId,
      connectionId: connection.connectionId,
    })
  ) {
    return true;
  }
  if (connection.ownerType !== 'project' || !connection.isDefault) return false;
  if (await credentialExists(connector.connectorId, null)) return true;
  const [stored] = await db
    .select({ authSecret: connectors.authSecret })
    .from(connectors)
    .where(eq(connectors.connectorId, connector.connectorId))
    .limit(1);
  return stored?.authSecret
    ? projectSecretIsConfiguredForConsumer({
        projectId: connector.projectId,
        name: stored.authSecret,
        consumer: 'connector',
      })
    : false;
}

function trustedManagedAuthorization(
  connector: ConnectorRequirementRow,
  connection: ConnectorConnectionRow,
): boolean {
  return isTrustedManagedChannelAuthorization({
    providerType: connector.providerType,
    platform: connectorPlatform(connector.config),
    ownerType: connection.ownerType,
    ownerId: connection.ownerId,
    metadata: connection.metadata,
  });
}

export function mayUseLegacyDefaultConnection(hasAnyDurableBinding: boolean): boolean {
  return !hasAnyDurableBinding;
}

// Canonicalization lives in shared/ so pure IAM code can use it without
// inheriting this module's database dependency. Imported for local use and
// re-exported so existing importers are unaffected.
export { canonicalConnectorAlias, publicConnectorAlias };

export async function loadEmailInstallConnectionId(
  projectId: string,
  inboxId: string,
): Promise<string | null> {
  const rows = await db
    .select({
      connectionId: connectorConnections.connectionId,
      metadata: connectorConnections.metadata,
      status: connectorConnections.status,
    })
    .from(connectorConnections)
    .innerJoin(
      connectors,
      eq(connectors.connectorId, connectorConnections.connectorId),
    )
    .where(
      and(
        eq(connectorConnections.projectId, projectId),
        eq(connectors.slug, canonicalConnectorAlias('email')),
      ),
    );
  return (
    rows.find(
      (row) =>
        row.status === 'active' && (row.metadata as Record<string, unknown>)?.inbox_id === inboxId,
    )?.connectionId ?? null
  );
}

export async function ensureEmailSessionBinding(input: {
  projectId: string;
  sessionId: string;
  inboxId: string;
}): Promise<boolean> {
  const connectionId = await loadEmailInstallConnectionId(input.projectId, input.inboxId);
  if (!connectionId) return false;
  const [connection] = await db
    .select({
      accountId: connectorConnections.accountId,
      connectorId: connectorConnections.connectorId,
    })
    .from(connectorConnections)
    .where(eq(connectorConnections.connectionId, connectionId))
    .limit(1);
  const [session] = await db
    .select({ accountId: projectSessions.accountId })
    .from(projectSessions)
    .where(
      and(
        eq(projectSessions.sessionId, input.sessionId),
        eq(projectSessions.projectId, input.projectId),
      ),
    )
    .limit(1);
  if (!connection || !session || connection.accountId !== session.accountId) return false;
  try {
    await db.insert(projectSessionConnectorBindings).values({
      sessionId: input.sessionId,
      accountId: session.accountId,
      projectId: input.projectId,
      connectorAlias: canonicalConnectorAlias('email'),
      connectorId: connection.connectorId,
      connectionId,
      source: 'default',
      createdBy: null,
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
  const [binding] = await db
    .select({ connectionId: projectSessionConnectorBindings.connectionId })
    .from(projectSessionConnectorBindings)
    .where(
      and(
        eq(projectSessionConnectorBindings.sessionId, input.sessionId),
        eq(projectSessionConnectorBindings.connectorAlias, canonicalConnectorAlias('email')),
      ),
    )
    .limit(1);
  return binding?.connectionId === connectionId;
}

export function parseSessionConnectorBindings(
  value: unknown,
): { ok: true; bindings: SessionConnectorBindings | undefined } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, bindings: undefined };
  const parsed = SessionConnectorBindingsInputSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues.map((issue) => issue.message).join('; '),
    };
  }
  return { ok: true, bindings: parsed.data };
}

export async function validateSessionConnectorBindings(input: {
  accountId: string;
  projectId: string;
  actingUserId: string;
  actingPrincipalIsServiceAccount: boolean;
  /** @deprecated Authorization strategy is the only owner gate. */
  mayManageSystemConnections: boolean;
  bindings: SessionConnectorBindings | undefined;
}): Promise<
  | { ok: true; bindings: ValidatedSessionConnectorBinding[] }
  | { ok: false; error: string; code: string }
> {
  if (!input.bindings) return { ok: true, bindings: [] };

  const validated: ValidatedSessionConnectorBinding[] = [];
  for (const [requestedAlias, binding] of Object.entries(input.bindings)) {
    const alias = canonicalConnectorAlias(requestedAlias);
    const [row] = await db
      .select({
        connectionId: connectorConnections.connectionId,
        connectorId: connectorConnections.connectorId,
        ownerType: connectorConnections.ownerType,
        ownerId: connectorConnections.ownerId,
        isDefault: connectorConnections.isDefault,
        status: connectorConnections.status,
        metadata: connectorConnections.metadata,
        connectorEnabled: connectors.enabled,
        connectorStatus: connectors.status,
        connectorName: connectors.name,
        providerType: connectors.providerType,
        connectorConfig: connectors.config,
        authorizationStrategy: connectors.authorizationStrategy,
      })
      .from(connectorConnections)
      .innerJoin(
        connectors,
        and(
          eq(connectors.connectorId, connectorConnections.connectorId),
          eq(connectors.accountId, connectorConnections.accountId),
          eq(connectors.projectId, connectorConnections.projectId),
        ),
      )
      .where(
        and(
          eq(connectorConnections.connectionId, binding.connection_id),
          eq(connectorConnections.accountId, input.accountId),
          eq(connectorConnections.projectId, input.projectId),
          eq(connectors.slug, alias),
        ),
      )
      .limit(1);

    if (!row) {
      return {
        ok: false,
        error: `Connection is not available for connector alias "${alias}" in this project`,
        code: 'CONNECTOR_CONNECTION_NOT_FOUND',
      };
    }
    const connector: ConnectorRequirementRow = {
      connectorId: row.connectorId,
      projectId: input.projectId,
      slug: alias,
      name: row.connectorName,
      providerType: row.providerType,
      config: row.connectorConfig,
      authorizationStrategy: row.authorizationStrategy,
      enabled: row.connectorEnabled,
      status: row.connectorStatus,
    };
    const connection: ConnectorConnectionRow = {
      connectionId: row.connectionId,
      isDefault: row.isDefault,
      ownerType: row.ownerType,
      ownerId: row.ownerId,
      status: row.status,
      metadata: row.metadata,
    };
    if (
      !connectorAuthorizationMatchesStrategy({
        strategy: connector.authorizationStrategy,
        ownerType: connection.ownerType,
        ownerId: connection.ownerId,
        actingUserId: input.actingUserId,
        actingPrincipalIsServiceAccount: input.actingPrincipalIsServiceAccount,
        trustedManagedSystem: trustedManagedAuthorization(connector, connection),
      })
    ) {
      return {
        ok: false,
        error: `Connection is not available for connector alias "${alias}" in this project`,
        code: 'CONNECTOR_CONNECTION_NOT_FOUND',
      };
    }
    if (row.status !== 'active') {
      return {
        ok: false,
        error: `Connection for connector alias "${alias}" is not active`,
        code: 'CONNECTOR_CONNECTION_INACTIVE',
      };
    }
    if (!row.connectorEnabled) {
      return {
        ok: false,
        error: `Connector for alias "${alias}" is disabled`,
        code: 'CONNECTOR_CONNECTION_INACTIVE',
      };
    }
    if (row.connectorStatus !== 'active') {
      return {
        ok: false,
        error: `Connector for alias "${alias}" is not active`,
        code: 'CONNECTOR_CONNECTION_INACTIVE',
      };
    }
    if (!(await connectorConnectionIsConnected({ connector, connection }))) {
      return {
        ok: false,
        error: `Connection for connector alias "${alias}" is not connected`,
        code: 'CONNECTOR_CONNECTION_INACTIVE',
      };
    }
    validated.push({
      alias,
      connectionId: row.connectionId,
      connectorId: row.connectorId,
      ownerType: row.ownerType,
      ownerId: row.ownerId,
      authorizationStrategy: row.authorizationStrategy,
    });
  }
  return { ok: true, bindings: validated };
}

export type RequiredConnectorResolution =
  | { ok: true; bindings: ValidatedSessionConnectorBinding[] }
  | {
      ok: false;
      code: 'REQUIRED_CONNECTOR_CONNECTION_UNAVAILABLE';
      /** Every unconfigured alias, so one refusal is one round trip to fix. */
      aliases: string[];
      connectorConnections?: never;
    }
  | {
      ok: false;
      code: 'CONNECTOR_CONNECTION_REQUIRED';
      connectorConnections: RequiredConnectorConnection[];
      aliases?: never;
    };

export class RequiredConnectorConnectionUnavailableError extends Error {
  readonly code = 'REQUIRED_CONNECTOR_CONNECTION_UNAVAILABLE';

  /** Every unconfigured alias, matching what create's pre-flight returns. */
  readonly aliases: string[];

  /**
   * The first alias.
   *
   * Kept because callers read it, but the list is the contract: the docs tell
   * connectors this refusal names every failing alias, and a single-alias
   * throw made that false on the prompt path — a caller who fixed the one name
   * they were given got refused again by the next, once per round trip.
   */
  get alias(): string {
    return this.aliases[0] ?? '';
  }

  constructor(aliases: string | readonly string[]) {
    const list = (typeof aliases === 'string' ? [aliases] : [...aliases]).filter(
      (alias) => alias.length > 0,
    );
    const quoted = list.map((alias) => `"${alias}"`).join(', ');
    super(
      list.length === 1
        ? `Required connection ${quoted} is unavailable`
        : `Required connections ${quoted} are unavailable`,
    );
    this.aliases = list;
    this.name = 'RequiredConnectorConnectionUnavailableError';
  }
}

export async function resolveRequiredConnectorConnections(input: {
  accountId: string;
  projectId: string;
  actingUserId: string;
  actingPrincipalIsServiceAccount: boolean;
  aliases: readonly string[];
  explicitBindings?: readonly ValidatedSessionConnectorBinding[];
}): Promise<RequiredConnectorResolution> {
  const bindings: ValidatedSessionConnectorBinding[] = [];
  const missing: RequiredConnectorConnection[] = [];
  const unavailable: string[] = [];
  const seen = new Set<string>();
  const explicitlyBound = new Set(input.explicitBindings?.map((binding) => binding.alias) ?? []);
  for (const requestedAlias of input.aliases) {
    const alias = canonicalConnectorAlias(requestedAlias);
    if (seen.has(alias)) continue;
    seen.add(alias);
    if (explicitlyBound.has(alias)) continue;
    const [connectorRow] = await db
      .select({
        connectorId: connectors.connectorId,
        projectId: connectors.projectId,
        slug: connectors.slug,
        name: connectors.name,
        providerType: connectors.providerType,
        config: connectors.config,
        authorizationStrategy: connectors.authorizationStrategy,
        enabled: connectors.enabled,
        status: connectors.status,
      })
      .from(connectors)
      .where(
        and(
          eq(connectors.accountId, input.accountId),
          eq(connectors.projectId, input.projectId),
          eq(connectors.slug, alias),
        ),
      )
      .limit(1);
    if (!connectorRow) {
      // Keep scanning. Returning on the first unconfigured alias would hand the
      // caller one alias per round trip, and a caller that has to guess how many
      // more refusals are queued cannot show the end-user a complete checklist.
      unavailable.push(publicConnectorAlias(alias));
      continue;
    }
    const connector: ConnectorRequirementRow = connectorRow;
    const connectionRows = connector.enabled && connector.status === 'active'
      ? await db
          .select({
            connectionId: connectorConnections.connectionId,
            isDefault: connectorConnections.isDefault,
            ownerType: connectorConnections.ownerType,
            ownerId: connectorConnections.ownerId,
            status: connectorConnections.status,
            metadata: connectorConnections.metadata,
          })
          .from(connectorConnections)
          .where(
            and(
              eq(connectorConnections.accountId, input.accountId),
              eq(connectorConnections.projectId, input.projectId),
              eq(connectorConnections.connectorId, connector.connectorId),
              eq(connectorConnections.status, 'active'),
            ),
          )
          .orderBy(desc(connectorConnections.isDefault), connectorConnections.connectionId)
      : [];
    let selected: ConnectorConnectionRow | null = null;
    for (const connection of connectionRows) {
      if (
        !connectorAuthorizationMatchesStrategy({
          strategy: connector.authorizationStrategy,
          ownerType: connection.ownerType,
          ownerId: connection.ownerId,
          actingUserId: input.actingUserId,
          actingPrincipalIsServiceAccount: input.actingPrincipalIsServiceAccount,
          trustedManagedSystem: trustedManagedAuthorization(connector, connection),
        })
      ) {
        continue;
      }
      if (await connectorConnectionIsConnected({ connector, connection })) {
        selected = connection;
        break;
      }
    }
    if (!selected) {
      missing.push({
        id: connector.connectorId,
        slug: publicConnectorAlias(connector.slug),
        name: connector.name,
        authorization_strategy: connector.authorizationStrategy,
      });
      continue;
    }
    bindings.push({
      alias,
      connectionId: selected.connectionId,
      connectorId: connector.connectorId,
      ownerType: selected.ownerType,
      ownerId: selected.ownerId,
      authorizationStrategy: connector.authorizationStrategy,
    });
  }
  // An unconfigured alias outranks a missing authorization. Only the project
  // owner can add the connector, so sending the end-user into a connect flow for
  // a connector that does not exist yet would strand them; the caller has to fix
  // the manifest first and will re-hit the authorization gate on the retry.
  if (unavailable.length > 0) {
    return {
      ok: false,
      code: 'REQUIRED_CONNECTOR_CONNECTION_UNAVAILABLE',
      aliases: unavailable,
    };
  }
  if (missing.length > 0) {
    return {
      ok: false,
      code: 'CONNECTOR_CONNECTION_REQUIRED',
      connectorConnections: missing,
    };
  }
  return { ok: true, bindings };
}

export async function missingRequiredConnectorConnectionsForSession(input: {
  accountId: string;
  projectId: string;
  sessionId: string;
  aliases: readonly string[];
}): Promise<RequiredConnectorConnection[]> {
  const missing: RequiredConnectorConnection[] = [];
  // Collected, not thrown on sight. Create's pre-flight reports every
  // unconfigured alias at once and the docs promise the same shape here; a
  // throw inside the loop stopped at the first, so a project missing two
  // connectors took two failed prompts to discover the second.
  const unavailable: string[] = [];
  const seen = new Set<string>();
  for (const requestedAlias of input.aliases) {
    const alias = canonicalConnectorAlias(requestedAlias);
    if (seen.has(alias)) continue;
    seen.add(alias);
    const resolved = await resolveSessionConnectorConnection({
      accountId: input.accountId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      alias,
    });
    if (resolved) continue;
    const [connector] = await db
      .select({
        id: connectors.connectorId,
        slug: connectors.slug,
        name: connectors.name,
        authorizationStrategy: connectors.authorizationStrategy,
      })
      .from(connectors)
      .where(
        and(
          eq(connectors.accountId, input.accountId),
          eq(connectors.projectId, input.projectId),
          eq(connectors.slug, alias),
        ),
      )
      .limit(1);
    if (!connector) {
      unavailable.push(publicConnectorAlias(alias));
      continue;
    }
    missing.push({
      id: connector.id,
      slug: publicConnectorAlias(connector.slug),
      name: connector.name,
      authorization_strategy: connector.authorizationStrategy,
    });
  }
  // Same precedence as create's pre-flight: an alias with no connector at all
  // outranks one that merely needs authorizing. Sending someone into a connect
  // flow for a connector the project does not have would strand them there.
  if (unavailable.length > 0) {
    throw new RequiredConnectorConnectionUnavailableError(unavailable);
  }
  return missing;
}

export async function persistSessionConnectorBindings(input: {
  sessionId: string;
  accountId: string;
  projectId: string;
  createdBy: string;
  bindings: ValidatedSessionConnectorBinding[];
}): Promise<void> {
  if (input.bindings.length === 0) return;
  await db.insert(projectSessionConnectorBindings).values(
    input.bindings.map((binding) => ({
      sessionId: input.sessionId,
      accountId: input.accountId,
      projectId: input.projectId,
      connectorAlias: binding.alias,
      connectorId: binding.connectorId,
      connectionId: binding.connectionId,
      source: 'request' as const,
      createdBy: input.createdBy,
    })),
  );
}

export function sessionConnectorBindingsRequirePrivateVisibility(
  bindings: readonly ValidatedSessionConnectorBinding[],
): boolean {
  return bindings.some((binding) => binding.ownerType === 'member');
}

export async function sessionHasMemberConnectorBinding(input: {
  accountId: string;
  projectId: string;
  sessionId: string;
}): Promise<boolean> {
  const [row] = await db
    .select({ connectionId: projectSessionConnectorBindings.connectionId })
    .from(projectSessionConnectorBindings)
    .innerJoin(
      connectorConnections,
      eq(connectorConnections.connectionId, projectSessionConnectorBindings.connectionId),
    )
    .where(
      and(
        eq(projectSessionConnectorBindings.sessionId, input.sessionId),
        eq(projectSessionConnectorBindings.accountId, input.accountId),
        eq(projectSessionConnectorBindings.projectId, input.projectId),
        eq(connectorConnections.ownerType, 'member'),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * Resolve the effective connection on every connector request. A present but
 * revoked/error binding never falls through to a project default.
 */
export async function resolveSessionConnectorConnection(input: {
  accountId: string;
  projectId: string;
  sessionId: string | null;
  alias: string;
  actingUserId?: string;
  actingPrincipalIsServiceAccount?: boolean;
}): Promise<ResolvedSessionConnectorConnection | null> {
  const alias = canonicalConnectorAlias(input.alias);
  let actingUserId = input.actingUserId ?? '';
  let actingPrincipalIsServiceAccount = input.actingPrincipalIsServiceAccount ?? false;
  let visibility: 'private' | 'project' | 'restricted' = 'private';
  let connectorBindingsConfigured = false;
  let inheritUnbound = false;

  if (input.sessionId) {
    const [session] = await db
      .select({
        sessionId: projectSessions.sessionId,
        createdBy: projectSessions.createdBy,
        visibility: projectSessions.visibility,
        bindingsConfigured: projectSessions.connectorBindingsConfigured,
        inheritUnbound: projectSessions.connectorBindingsInheritUnbound,
        createdByServiceAccountId: serviceAccounts.serviceAccountId,
      })
      .from(projectSessions)
      .leftJoin(
        serviceAccounts,
        and(
          eq(serviceAccounts.serviceAccountId, projectSessions.createdBy),
          eq(serviceAccounts.accountId, projectSessions.accountId),
        ),
      )
      .where(
        and(
          eq(projectSessions.sessionId, input.sessionId),
          eq(projectSessions.accountId, input.accountId),
          eq(projectSessions.projectId, input.projectId),
        ),
      )
      .limit(1);
    if (!session) return null;
    actingUserId = session.createdBy ?? '';
    actingPrincipalIsServiceAccount = session.createdByServiceAccountId !== null;
    visibility = session.visibility;
    connectorBindingsConfigured = session.bindingsConfigured;
    inheritUnbound = session.inheritUnbound;

    const [bound] = await db
      .select({
        connectionId: connectorConnections.connectionId,
        connectorId: connectorConnections.connectorId,
        connectionStatus: connectorConnections.status,
        isDefault: connectorConnections.isDefault,
        metadata: connectorConnections.metadata,
        ownerType: connectorConnections.ownerType,
        ownerId: connectorConnections.ownerId,
        source: projectSessionConnectorBindings.source,
        connectorName: connectors.name,
        providerType: connectors.providerType,
        connectorConfig: connectors.config,
        authorizationStrategy: connectors.authorizationStrategy,
        connectorEnabled: connectors.enabled,
        connectorStatus: connectors.status,
      })
      .from(projectSessionConnectorBindings)
      .innerJoin(
        connectorConnections,
        eq(connectorConnections.connectionId, projectSessionConnectorBindings.connectionId),
      )
      .innerJoin(
        connectors,
        and(
          eq(connectors.connectorId, projectSessionConnectorBindings.connectorId),
          eq(connectors.accountId, projectSessionConnectorBindings.accountId),
          eq(connectors.projectId, projectSessionConnectorBindings.projectId),
        ),
      )
      .where(
        and(
          eq(projectSessionConnectorBindings.sessionId, input.sessionId),
          eq(projectSessionConnectorBindings.accountId, input.accountId),
          eq(projectSessionConnectorBindings.projectId, input.projectId),
          eq(projectSessionConnectorBindings.connectorAlias, alias),
        ),
      )
      .limit(1);
    if (bound) {
      const connector: ConnectorRequirementRow = {
        connectorId: bound.connectorId,
        projectId: input.projectId,
        slug: alias,
        name: bound.connectorName,
        providerType: bound.providerType,
        config: bound.connectorConfig,
        authorizationStrategy: bound.authorizationStrategy,
        enabled: bound.connectorEnabled,
        status: bound.connectorStatus,
      };
      const connection: ConnectorConnectionRow = {
        connectionId: bound.connectionId,
        isDefault: bound.isDefault,
        ownerType: bound.ownerType,
        ownerId: bound.ownerId,
        status: bound.connectionStatus,
        metadata: bound.metadata,
      };
      if (
        !connector.enabled ||
        connector.status !== 'active' ||
        connection.status !== 'active' ||
        (connection.ownerType === 'member' && visibility !== 'private') ||
        !connectorAuthorizationMatchesStrategy({
          strategy: connector.authorizationStrategy,
          ownerType: connection.ownerType,
          ownerId: connection.ownerId,
          actingUserId,
          actingPrincipalIsServiceAccount,
          trustedManagedSystem: trustedManagedAuthorization(connector, connection),
        }) ||
        !(await connectorConnectionIsConnected({ connector, connection }))
      ) {
        return null;
      }
      return {
        connectionId: bound.connectionId,
        connectorId: bound.connectorId,
        status: bound.connectionStatus,
        isDefault: bound.isDefault,
        source: bound.source,
        alias,
        metadata: bound.metadata ?? {},
      };
    }
    if (connectorBindingsConfigured && !inheritUnbound) return null;
  }

  // Hand the project-default fallback the SAME principal identity the original
  // inlined branch used: when a session is in scope, the session-resolved
  // service-account flag (line 715) is authoritative and detection must NOT
  // re-run (the original skipped it when `input.sessionId` was set). When no
  // session is in scope, pass the RAW caller value so the helper's
  // `=== undefined` detection runs exactly as before.
  const fallbackFromDefault = await resolveProjectDefaultConnectorConnection({
    accountId: input.accountId,
    projectId: input.projectId,
    alias,
    actingUserId,
    actingPrincipalIsServiceAccount: input.sessionId
      ? actingPrincipalIsServiceAccount
      : input.actingPrincipalIsServiceAccount,
    visibility,
  });
  return fallbackFromDefault;
}

/**
 * Project-default connection resolution — the fallback an UNBOUND alias resolves
 * to when no session binding covers it (or no session is in scope at all).
 *
 * Strategy/visibility/connectivity-aware: it walks the connector's active
 * connections (default first), keeps the first that matches the connector's
 * authorization strategy, the session's visibility, and is actually
 * connected, and stamps it `source: 'default'`.
 *
 * Kept separate from `resolveSessionConnectorConnection` so callers that need the
 * project default can resolve it directly. Connector discovery and execution do
 * not call this helper. They use `resolveSessionConnectorConnection`, which also
 * enforces the stored session scope.
 */
export async function resolveProjectDefaultConnectorConnection(input: {
  accountId: string;
  projectId: string;
  alias: string;
  actingUserId?: string;
  actingPrincipalIsServiceAccount?: boolean;
  visibility?: 'private' | 'project' | 'restricted';
}): Promise<ResolvedSessionConnectorConnection | null> {
  const alias = canonicalConnectorAlias(input.alias);
  let actingUserId = input.actingUserId ?? '';
  let actingPrincipalIsServiceAccount = input.actingPrincipalIsServiceAccount ?? false;
  let visibility: 'private' | 'project' | 'restricted' = input.visibility ?? 'private';

  if (
    input.actingPrincipalIsServiceAccount === undefined &&
    actingUserId.length > 0
  ) {
    const [serviceAccount] = await db
      .select({ id: serviceAccounts.serviceAccountId })
      .from(serviceAccounts)
      .where(
        and(
          eq(serviceAccounts.serviceAccountId, actingUserId),
          eq(serviceAccounts.accountId, input.accountId),
        ),
      )
      .limit(1);
    actingPrincipalIsServiceAccount = serviceAccount !== undefined;
  }

  const [connectorRow] = await db
    .select({
      connectorId: connectors.connectorId,
      projectId: connectors.projectId,
      slug: connectors.slug,
      name: connectors.name,
      providerType: connectors.providerType,
      config: connectors.config,
      authorizationStrategy: connectors.authorizationStrategy,
      enabled: connectors.enabled,
      status: connectors.status,
    })
    .from(connectors)
    .where(
      and(
        eq(connectors.accountId, input.accountId),
        eq(connectors.projectId, input.projectId),
        eq(connectors.slug, alias),
      ),
    )
    .limit(1);
  if (!connectorRow || !connectorRow.enabled || connectorRow.status !== 'active') return null;
  const connector: ConnectorRequirementRow = connectorRow;
  const connections = await db
    .select({
      connectionId: connectorConnections.connectionId,
      isDefault: connectorConnections.isDefault,
      ownerType: connectorConnections.ownerType,
      ownerId: connectorConnections.ownerId,
      status: connectorConnections.status,
      metadata: connectorConnections.metadata,
    })
    .from(connectorConnections)
    .where(
      and(
        eq(connectorConnections.accountId, input.accountId),
        eq(connectorConnections.projectId, input.projectId),
        eq(connectorConnections.connectorId, connector.connectorId),
        eq(connectorConnections.status, 'active'),
      ),
    )
    .orderBy(desc(connectorConnections.isDefault), connectorConnections.connectionId);
  let fallback: ConnectorConnectionRow | null = null;
  for (const connection of connections) {
    if (
      !connectorAuthorizationMatchesStrategy({
        strategy: connector.authorizationStrategy,
        ownerType: connection.ownerType,
        ownerId: connection.ownerId,
        actingUserId,
        actingPrincipalIsServiceAccount,
        trustedManagedSystem: trustedManagedAuthorization(connector, connection),
      })
    ) {
      continue;
    }
    if (connection.ownerType === 'member' && visibility !== 'private') continue;
    if (await connectorConnectionIsConnected({ connector, connection })) {
      fallback = connection;
      break;
    }
  }
  if (!fallback) return null;
  return {
    connectionId: fallback.connectionId,
    connectorId: connector.connectorId,
    status: fallback.status,
    isDefault: fallback.isDefault,
    alias,
    metadata: fallback.metadata ?? {},
    source: 'default',
  };
}

/**
 * Return the authorization map that Connector resolves for the session now.
 *
 * A session without caller-configured bindings can use strategy-based defaults
 * without durable binding rows. Read-back must materialize those defaults.
 * Explicit-only sessions remain explicit-only because
 * `resolveSessionConnectorConnection` enforces the persisted inheritance state.
 */
export async function resolveEffectiveSessionConnectorBindings(input: {
  accountId: string;
  projectId: string;
  sessionId: string;
  grantedConnectors: string[] | 'all' | undefined;
}): Promise<SessionConnectorBindings> {
  const requestedAliases = Array.isArray(input.grantedConnectors)
    ? input.grantedConnectors
    : (
        await db
          .select({ alias: connectors.slug })
          .from(connectors)
          .where(
            and(
              eq(connectors.accountId, input.accountId),
              eq(connectors.projectId, input.projectId),
              eq(connectors.enabled, true),
              eq(connectors.status, 'active'),
            ),
          )
          .orderBy(connectors.slug)
      ).map((row) => row.alias);

  const bindings: SessionConnectorBindings = {};
  const seen = new Set<string>();
  for (const requestedAlias of requestedAliases) {
    const alias = canonicalConnectorAlias(requestedAlias);
    if (seen.has(alias)) continue;
    seen.add(alias);
    const resolved = await resolveSessionConnectorConnection({
      accountId: input.accountId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      alias,
    });
    if (!resolved) continue;
    bindings[publicConnectorAlias(resolved.alias)] = {
      connection_id: resolved.connectionId,
    };
  }
  return bindings;
}

export function canonicalConnectorBindings(value: unknown): string {
  const parsed = parseSessionConnectorBindings(value);
  if (!parsed.ok || !parsed.bindings) return '{}';
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(parsed.bindings)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([alias, binding]) => [
          alias,
          { connection_id: binding.connection_id },
        ]),
    ),
  );
}

export function connectorBindingPayloadConflicts(existing: unknown, requested: unknown): boolean {
  return canonicalConnectorBindings(existing) !== canonicalConnectorBindings(requested);
}
