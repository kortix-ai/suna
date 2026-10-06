import { connectorConnections, connectors } from '@kortix/db';
import { eq } from 'drizzle-orm';
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
import {
  type ConnectionAudienceReach,
  type ConnectionReachabilityActor,
  connectionRowIsReachable,
} from './connection-access';
import { projectSecretIsConfiguredForConsumer } from '../secrets';

export interface ValidatedSessionConnectorBinding {
  alias: string;
  connectionId: string;
  connectorId: string;
  ownerType: 'project' | 'agent' | 'member' | 'subject' | 'external';
  ownerId: string | null;
  /** A private account, or a shared one narrowed to an audience: the session
   *  that binds it must stay private (`connectionNeedsPrivateSession`). */
  personal: boolean;
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

export interface ConnectorRequirementRow {
  connectorId: string;
  projectId: string;
  slug: string;
  name: string;
  providerType: string;
  config: Record<string, unknown>;
  enabled: boolean;
  status: 'active' | 'disabled' | 'needs_auth' | 'error';
}

export interface ConnectorConnectionRow {
  connectionId: string;
  isDefault: boolean;
  ownerType: 'project' | 'agent' | 'member' | 'subject' | 'external';
  ownerId: string | null;
  status: 'active' | 'revoked' | 'error';
  metadata: Record<string, unknown>;
}

/**
 * The shared columns of the bound-connection read: the connection row joined
 * to its connector row, keyed for a session binding lookup. Callers add only
 * the binding-side columns they need (`source`, `connectionLabel`, or `alias`)
 * on top of this, so the join's column list lives in exactly one place.
 */
export function boundConnectionSelect() {
  return {
    connectionId: connectorConnections.connectionId,
    connectorId: connectorConnections.connectorId,
    connectionStatus: connectorConnections.status,
    isDefault: connectorConnections.isDefault,
    metadata: connectorConnections.metadata,
    ownerType: connectorConnections.ownerType,
    ownerId: connectorConnections.ownerId,
    connectorName: connectors.name,
    providerType: connectors.providerType,
    connectorConfig: connectors.config,
    connectorEnabled: connectors.enabled,
    connectorStatus: connectors.status,
  };
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

export function sessionConnectionIsReachable(
  connector: ConnectorRequirementRow,
  connection: ConnectorConnectionRow,
  actor: ConnectionReachabilityActor,
  audience: ConnectionAudienceReach,
): boolean {
  return connectionRowIsReachable(
    {
      ownerType: connection.ownerType,
      ownerId: connection.ownerId,
      metadata: connection.metadata,
      providerType: connector.providerType,
      connectorConfig: connector.config,
    },
    actor,
    audience,
  );
}

/**
 * Does the account the caller named describe the connection this session pinned?
 * Accepts the same grammar as `selectEntitledConnectorConnection`: a connection
 * id, a label, or the selector words `me` / `project`.
 */
export function boundConnectionAnswersTo(
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
