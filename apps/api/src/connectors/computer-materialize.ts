/**
 * Auto-materialize the `computer` connector from connected machines.
 *
 * Exactly like the Slack `channel` connector, `computer` is a REGULAR connector
 * with no `[[connectors]]` entry and no experimental opt-in — connecting a
 * machine over the Agent Computer Tunnel IS the registration. When a project's
 * account has connected machines, we synthesize one ConnectorSpec PER MACHINE
 * so the materializer treats each profile like any other connector (DB rows,
 * the fixed action catalog, policies, and the connector surface). The connector
 * config binds its immutable tunnel id. There is no credential: the live WS
 * relay is the credential, and per-machine auth/scope is the tunnel permission
 * layer.
 *
 * NOT gated by the per-project `agent_tunnel` feature flag: a machine can
 * only exist when the platform tunnel service is on (the tunnel routes are
 * `config.TUNNEL_ENABLED`-gated), so machine-presence already implies platform
 * support. The `agent_tunnel` flag now only gates the dedicated Computers
 * management UI (device-auth / per-machine permissions), not the connector.
 * See docs/specs/computer-connector.md.
 *
 * "Connected machine" means the tunnel has completed a real WS handshake at
 * least once (`last_heartbeat_at IS NOT NULL`) — NOT merely that a
 * `tunnel_connections` row exists. Approving a device-auth request creates the
 * row up front with `status: 'offline'` and no heartbeat, and the CLI then
 * dials in and flips it live within seconds; requiring a heartbeat costs that
 * flow nothing. What it excludes is a pairing that was approved (or seeded —
 * e.g. by a test) and then never actually connected: without this check that
 * row sits forever and silently materializes an "active" `computer` connector
 * across every project in the account, looking exactly like a real,
 * intentionally-added connector even though nothing is or ever was connected.
 * Once a machine has connected at least once, its connector correctly stays
 * materialized through later offline periods (closed laptop, etc.) — only a
 * connection that never came online even once is excluded.
 */
import { and, eq, isNotNull } from 'drizzle-orm';
import { projects, tunnelConnections } from '@kortix/db';
import { db } from '../shared/db';
import { computerConnectorSlug } from './computers';
import type { ConnectorSpec } from '../projects/connectors';
import { MANIFEST_FILENAME } from '../projects/triggers';

function computerSpec(tunnel: {
  tunnelId: string;
  name: string;
}): ConnectorSpec {
  const slug = computerConnectorSlug(tunnel.tunnelId);
  return {
    slug,
    path: `${MANIFEST_FILENAME}#connectors.${slug} (auto: tunnel)`,
    name: tunnel.name || `Computer ${tunnel.tunnelId.slice(0, 8)}`,
    enabled: true,
    provider: 'computer',
    credentialMode: 'shared',
    authorizationStrategy: 'project',
    sensitive: false,
    app: null,
    account: null,
    url: null,
    transport: null,
    endpoint: null,
    baseUrl: null,
    platform: null,
    spec: null,
    tunnelId: tunnel.tunnelId,
    auth: {
      type: 'none',
      in: 'header',
      name: null,
      prefix: null,
      secret: null,
    },
    // Platform-called connector — the request isn't built by executeCall's
    // HTTP builders, so a static header table would be inert. Always empty.
    headers: {},
    policies: [],
  };
}

/**
 * One synthetic ConnectorSpec per machine that completed a handshake. Specs are
 * never written to git. A declared slug wins defensively, although the UUID-
 * based platform slug makes a collision impractical.
 */
export async function synthesizeComputerConnectors(
  projectId: string,
  declared: ConnectorSpec[],
): Promise<ConnectorSpec[]> {
  const [proj] = await db
    .select({ accountId: projects.accountId })
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);
  if (!proj) return [];

  const tunnels = await db
    .select({
      tunnelId: tunnelConnections.tunnelId,
      name: tunnelConnections.name,
    })
    .from(tunnelConnections)
    .where(
      and(
        eq(tunnelConnections.accountId, proj.accountId),
        isNotNull(tunnelConnections.lastHeartbeatAt),
      ),
    );
  const declaredSlugs = new Set(declared.map((spec) => spec.slug));
  return tunnels.map(computerSpec).filter((spec) => !declaredSlugs.has(spec.slug));
}
