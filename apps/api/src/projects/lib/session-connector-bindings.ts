import {
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
  connectionIsEffectiveProjectDefault,
} from '../../connectors/credentials';
import { db } from '../../shared/db';
import { isUniqueViolation } from '../../shared/postgres-errors';
import {
  connectionIsReachable,
  isTrustedManagedChannelAuthorization,
} from './connection-access';
import { projectSecretIsConfiguredForConsumer } from '../secrets';

export interface ValidatedSessionConnectorBinding {
  alias: string;
  connectionId: string;
  connectorId: string;
  ownerType: 'project' | 'agent' | 'member' | 'subject' | 'external';
  ownerId: string | null;
}

export interface ResolvedSessionConnectorConnection {
  connectionId: string;
  connectorId: string;
  alias: string;
  status: 'active' | 'revoked' | 'error';
  isDefault: boolean;
  metadata: Record<string, unknown>;
  source: 'request' | 'default';
  /**
   * Human-facing account name and ownership, carried so every successful call
   * can echo WHICH identity ran it. A transcript that does not name the
   * account cannot be read back later to answer "whose mailbox sent that".
   */
  label: string;
  ownerType: 'project' | 'agent' | 'member' | 'subject' | 'external';
}

interface ConnectorRequirementRow {
  connectorId: string;
  projectId: string;
  slug: string;
  name: string;
  providerType: string;
  config: Record<string, unknown>;
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
  if (connection.ownerType !== 'project') return false;
  // INVARIANT (2026-09-16, account_required rule): only the connector's
  // EFFECTIVE project default may inherit the legacy connector-level
  // credential — pinned, or (unchanged from before this rule) the connector's
  // sole active project-owned connection when nothing is pinned. See
  // `defaultConnectionIdForConnector`.
  if (!(await connectionIsEffectiveProjectDefault(connector.connectorId, connection.connectionId))) {
    return false;
  }
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

/**
 * Does the account the caller named describe the connection this session pinned?
 * Accepts the same grammar as `selectEntitledConnectorConnection`: a connection
 * id, a label, or the selector words `me` / `project`.
 */
function boundConnectionAnswersTo(
  account: string,
  bound: {
    connectionId: string;
    connectionLabel: string;
    ownerType: 'project' | 'agent' | 'member' | 'subject' | 'external';
  },
): boolean {
  const wanted = account.trim().toLowerCase();
  if (wanted === 'me') return bound.ownerType === 'member';
  if (wanted === 'project') return bound.ownerType !== 'member';
  return (
    wanted === bound.connectionId.toLowerCase() ||
    wanted === bound.connectionLabel.trim().toLowerCase()
  );
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
      !connectionIsReachable({
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
    });
  }
  return { ok: true, bindings: validated };
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
 *
 * Returns the full outcome (see `ResolvedConnectorConnectionOutcome`) so a
 * caller that must distinguish "nothing reachable" from "several reachable
 * accounts and none named or pinned" — the gateway's `account_required`
 * denial — can. `resolveSessionConnectorConnection` below is a thin wrapper
 * for the many callers that only ever asked "did this resolve".
 *
 * A session PIN (an explicit `projectSessionConnectorBindings` row) is never
 * ambiguous — it is the caller's own prior explicit choice, so it resolves
 * directly (`ok`) or fails closed (`none`) exactly as before; only the
 * project-default FALLBACK (no binding, or an inherit-unbound session) can
 * ever return `ambiguous`.
 */
export async function resolveSessionConnectorConnectionOutcome(input: {
  accountId: string;
  projectId: string;
  sessionId: string | null;
  alias: string;
  actingUserId?: string;
  actingPrincipalIsServiceAccount?: boolean;
  /**
   * Name or id of the account to run this call as, when the caller named one.
   * Omitted resolves exactly as before: the session's binding if it holds one,
   * otherwise the project-default resolution rule (see
   * `selectEntitledConnectorConnection`).
   *
   * A NAMED account is never silently substituted. It is matched against the
   * accounts this caller is entitled to and, failing that, the call is denied —
   * running "send mail as Work" against Personal is worse than not running.
   */
  account?: string | null;
}): Promise<ResolvedConnectorConnectionOutcome> {
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
    if (!session) return { kind: 'none' };
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
        connectionLabel: connectorConnections.label,
        isDefault: connectorConnections.isDefault,
        metadata: connectorConnections.metadata,
        ownerType: connectorConnections.ownerType,
        ownerId: connectorConnections.ownerId,
        source: projectSessionConnectorBindings.source,
        connectorName: connectors.name,
        providerType: connectors.providerType,
        connectorConfig: connectors.config,
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
        !connectionIsReachable({
          ownerType: connection.ownerType,
          ownerId: connection.ownerId,
          actingUserId,
          actingPrincipalIsServiceAccount,
          trustedManagedSystem: trustedManagedAuthorization(connector, connection),
        }) ||
        !(await connectorConnectionIsConnected({ connector, connection }))
      ) {
        return { kind: 'none' };
      }
      // A session that PINNED an account is a constraint, not a suggestion. A
      // call that names a different one is denied rather than quietly run
      // against the pinned account — the caller asked for a specific mailbox.
      if (input.account?.trim() && !boundConnectionAnswersTo(input.account, bound)) {
        return { kind: 'none' };
      }
      return {
        kind: 'ok',
        connection: {
          connectionId: bound.connectionId,
          connectorId: bound.connectorId,
          status: bound.connectionStatus,
          isDefault: bound.isDefault,
          source: bound.source,
          alias,
          metadata: bound.metadata ?? {},
          label: bound.connectionLabel,
          ownerType: bound.ownerType,
        },
      };
    }
    if (connectorBindingsConfigured && !inheritUnbound) return { kind: 'none' };
  }

  // Hand the project-default fallback the SAME principal identity the original
  // inlined branch used: when a session is in scope, the session-resolved
  // service-account flag (line 715) is authoritative and detection must NOT
  // re-run (the original skipped it when `input.sessionId` was set). When no
  // session is in scope, pass the RAW caller value so the helper's
  // `=== undefined` detection runs exactly as before.
  return resolveProjectDefaultConnectorConnectionOutcome({
    accountId: input.accountId,
    projectId: input.projectId,
    alias,
    actingUserId,
    actingPrincipalIsServiceAccount: input.sessionId
      ? actingPrincipalIsServiceAccount
      : input.actingPrincipalIsServiceAccount,
    visibility,
    account: input.account,
  });
}

/** `resolveSessionConnectorConnectionOutcome`, collapsed to the pre-existing
 *  `T | null` shape for the many callers that only ever asked "did this
 *  resolve" — `ambiguous` collapses to `null` here exactly like "nothing
 *  reachable" did before this rule existed; a caller that must tell them
 *  apart (the gateway's `account_required` denial) uses the outcome-returning
 *  sibling above directly. */
export async function resolveSessionConnectorConnection(
  input: Parameters<typeof resolveSessionConnectorConnectionOutcome>[0],
): Promise<ResolvedSessionConnectorConnection | null> {
  const outcome = await resolveSessionConnectorConnectionOutcome(input);
  return outcome.kind === 'ok' ? outcome.connection : null;
}

/**
 * EVERY connection for this alias the caller is entitled to use, default first.
 *
 * One connector can hold several accounts — the project's shared one and each
 * member's own ("Work", "Personal"). Resolution used to stop at the first
 * match and nothing could reach the rest, so the only way to use a second
 * account was to pin it per session from a dropdown in the composer. The list
 * is the primitive now: the CLI prints it, a call selects from it by name, and
 * an unselected call takes the first entry exactly as before.
 *
 * Entitlement is three filters: the row's reachability for this principal
 * (`connectionIsReachable`), the session's visibility (a member-owned account
 * never leaks into a shared session), and whether the account is genuinely
 * connected.
 *
 * Order: the caller's own default private account, their other private
 * accounts, the project's default shared account, then the rest. A call that
 * names no account takes the first entry, so "my own identity first, the
 * project's shared one as the fallback" is the resolution rule.
 */
export interface EntitledConnectorConnection {
  connectionId: string;
  connectorId: string;
  alias: string;
  /** Human-facing account name. What `--account` matches on. */
  label: string;
  ownerType: 'project' | 'agent' | 'member' | 'subject' | 'external';
  isDefault: boolean;
  status: 'active' | 'revoked' | 'error';
  metadata: Record<string, unknown>;
}

export async function listEntitledConnectorConnections(input: {
  accountId: string;
  projectId: string;
  alias: string;
  actingUserId?: string;
  actingPrincipalIsServiceAccount?: boolean;
  visibility?: 'private' | 'project' | 'restricted';
}): Promise<EntitledConnectorConnection[]> {
  const alias = canonicalConnectorAlias(input.alias);
  const actingUserId = input.actingUserId ?? '';
  let actingPrincipalIsServiceAccount = input.actingPrincipalIsServiceAccount ?? false;
  const visibility: 'private' | 'project' | 'restricted' = input.visibility ?? 'private';

  if (input.actingPrincipalIsServiceAccount === undefined && actingUserId.length > 0) {
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
  if (!connectorRow || !connectorRow.enabled || connectorRow.status !== 'active') return [];
  const connector: ConnectorRequirementRow = connectorRow;

  const rows = await db
    .select({
      connectionId: connectorConnections.connectionId,
      label: connectorConnections.label,
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

  const entitled: EntitledConnectorConnection[] = [];
  for (const row of rows) {
    const connection: ConnectorConnectionRow = {
      connectionId: row.connectionId,
      isDefault: row.isDefault,
      ownerType: row.ownerType,
      ownerId: row.ownerId,
      status: row.status,
      metadata: row.metadata,
    };
    if (
      !connectionIsReachable({
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
    if (!(await connectorConnectionIsConnected({ connector, connection }))) continue;
    entitled.push({
      connectionId: row.connectionId,
      connectorId: connector.connectorId,
      alias,
      label: row.label,
      ownerType: row.ownerType,
      isDefault: row.isDefault,
      status: row.status,
      metadata: row.metadata ?? {},
    });
  }
  // Every member-owned row that survived the filter is the CALLER's own, so
  // owner type alone ranks the list. `sort` is stable, so rows inside a rank
  // keep the query's `connectionId` order.
  return entitled.sort(
    (a, b) => entitledConnectionRank(a) - entitledConnectionRank(b),
  );
}

function entitledConnectionRank(connection: EntitledConnectorConnection): number {
  if (connection.ownerType === 'member') return connection.isDefault ? 0 : 1;
  return connection.isDefault ? 2 : 3;
}

/**
 * The outcome of picking one entitled account.
 *
 * THE RULE (INC-class, 2026-09-16): an unnamed (or `me`/`project`-shorthand)
 * connector call uses an account implicitly ONLY when exactly one account is
 * reachable, OR a human has deliberately pinned a default. A silent tie-break
 * among several equally-reachable accounts is a guess with real consequences
 * — mail sent from the wrong mailbox. `ambiguous` is a DISTINCT outcome from
 * `none` so a caller can never conflate "nothing here" with "several things
 * here and I refuse to guess which."
 */
export type EntitledConnectionSelection =
  | { kind: 'none' }
  | { kind: 'one'; connection: EntitledConnectorConnection }
  | { kind: 'ambiguous'; connections: readonly EntitledConnectorConnection[] };

/** 0 → none; 1 → it; 2+ → the pinned one iff exactly one is pinned, else ambiguous. */
function resolveEntitledTier(
  connections: readonly EntitledConnectorConnection[],
): EntitledConnectionSelection {
  if (connections.length === 0) return { kind: 'none' };
  if (connections.length === 1) return { kind: 'one', connection: connections[0]! };
  const pinned = connections.filter((c) => c.isDefault);
  if (pinned.length === 1) return { kind: 'one', connection: pinned[0]! };
  return { kind: 'ambiguous', connections };
}

/**
 * Pick one entitled account by name.
 *
 * Matches a connection id exactly, a label case-insensitively — the CLI prints
 * both, and a human types the label — or the two selector words:
 *
 *   `me`      the caller's pinned private account, else their only private
 *             one, else AMBIGUOUS among their private accounts.
 *   `project` the pinned shared account, else the only shared one, else
 *             AMBIGUOUS among the shared accounts.
 *
 * The words are matched BEFORE labels, so a connection literally labelled
 * "me" is still reachable by its id. An unnamed call (no `account` at all)
 * applies the same 0/1/pinned/ambiguous rule to the WHOLE entitled list,
 * unfiltered — this is what replaced "always take the first entry".
 *
 * A named-but-unknown account returns `none`, which the caller reports as "no
 * such account" rather than silently running as a different one than asked
 * for. Silently falling back would be the worst outcome here: the call would
 * succeed against the wrong mailbox. `ambiguous` is reported differently
 * (`account_required`): several real candidates exist and none was named.
 */
export function selectEntitledConnectorConnection(
  connections: readonly EntitledConnectorConnection[],
  account: string | null | undefined,
): EntitledConnectionSelection {
  if (!account || !account.trim()) return resolveEntitledTier(connections);
  const wanted = account.trim().toLowerCase();
  if (wanted === 'me') {
    return resolveEntitledTier(connections.filter((c) => c.ownerType === 'member'));
  }
  if (wanted === 'project') {
    return resolveEntitledTier(connections.filter((c) => c.ownerType !== 'member'));
  }
  const named =
    connections.find((c) => c.connectionId.toLowerCase() === wanted) ??
    connections.find((c) => c.label.trim().toLowerCase() === wanted) ??
    null;
  return named ? { kind: 'one', connection: named } : { kind: 'none' };
}

/** The outcome of resolving a connector connection: found, absent, or
 *  AMBIGUOUS (several reachable accounts, none named, none pinned — see
 *  `EntitledConnectionSelection`). A `null`-collapsing caller cannot tell
 *  "nothing here" from "several things here and nobody said which"; a caller
 *  that must (the gateway's `account_required` denial) uses this instead. */
export type ResolvedConnectorConnectionOutcome =
  | { kind: 'ok'; connection: ResolvedSessionConnectorConnection }
  | { kind: 'none' }
  | { kind: 'ambiguous'; accounts: readonly EntitledConnectorConnection[] };

/**
 * Project-default connection resolution — the fallback an UNBOUND alias resolves
 * to when no session binding covers it (or no session is in scope at all).
 *
 * A thin pick over `listEntitledConnectorConnections` + `selectEntitledConnectorConnection`,
 * which preserves the original ordering (default first, then connection id) and
 * the original three filters, so a call naming one account (or exactly one
 * reachable, or exactly one pinned) resolves to exactly what it always did.
 */
export async function resolveProjectDefaultConnectorConnectionOutcome(input: {
  accountId: string;
  projectId: string;
  alias: string;
  actingUserId?: string;
  actingPrincipalIsServiceAccount?: boolean;
  visibility?: 'private' | 'project' | 'restricted';
  /** Name or id of the account to run as. Omitted = the default. */
  account?: string | null;
}): Promise<ResolvedConnectorConnectionOutcome> {
  const entitled = await listEntitledConnectorConnections(input);
  const selection = selectEntitledConnectorConnection(entitled, input.account);
  if (selection.kind === 'none') return { kind: 'none' };
  if (selection.kind === 'ambiguous') return { kind: 'ambiguous', accounts: selection.connections };
  const chosen = selection.connection;
  return {
    kind: 'ok',
    connection: {
      connectionId: chosen.connectionId,
      connectorId: chosen.connectorId,
      status: chosen.status,
      isDefault: chosen.isDefault,
      alias: chosen.alias,
      metadata: chosen.metadata,
      source: 'default',
      label: chosen.label,
      ownerType: chosen.ownerType,
    },
  };
}

/** `resolveProjectDefaultConnectorConnectionOutcome`, collapsed to the pre-existing
 *  `T | null` shape for the many callers that only ever asked "did this resolve" —
 *  `ambiguous` collapses to `null` here exactly like "nothing reachable" did
 *  before this rule existed; a caller that must tell them apart uses the
 *  outcome-returning sibling above directly. */
export async function resolveProjectDefaultConnectorConnection(
  input: Parameters<typeof resolveProjectDefaultConnectorConnectionOutcome>[0],
): Promise<ResolvedSessionConnectorConnection | null> {
  const outcome = await resolveProjectDefaultConnectorConnectionOutcome(input);
  return outcome.kind === 'ok' ? outcome.connection : null;
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
