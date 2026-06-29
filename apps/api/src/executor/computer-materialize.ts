/**
 * Auto-materialize the `computer` connector from connected machines.
 *
 * Exactly like the Slack `channel` connector, `computer` is a REGULAR connector
 * with no `[[connectors]]` entry and no experimental opt-in — connecting a
 * machine over the Agent Computer Tunnel IS the registration. When a project's
 * account has at least one connected machine, we synthesize a SINGLE `computer`
 * ConnectorSpec here so the materializer treats it like any other connector (DB
 * rows, the fixed action catalog, sharing, policies, and the Executor/Connectors
 * surface). One connector fronts ALL the account's machines — the machine is a
 * call argument, resolved at call time. There is no credential: the live WS
 * relay is the credential, and per-machine auth/scope is the tunnel permission
 * layer.
 *
 * NOT gated by the per-project `agent_tunnel` experimental flag: a machine can
 * only exist when the platform tunnel service is on (the tunnel routes are
 * `config.TUNNEL_ENABLED`-gated), so machine-presence already implies platform
 * support. The `agent_tunnel` flag now only gates the dedicated Computers
 * management UI (device-auth / per-machine permissions), not the connector.
 * See docs/specs/computer-connector.md.
 */
import { eq } from 'drizzle-orm';
import { projects, tunnelConnections } from '@kortix/db';
import { db } from '../shared/db';
import { COMPUTER_SLUG, computerLabel } from './computers';
import type { ConnectorSpec } from '../projects/connectors';
import { MANIFEST_FILENAME } from '../projects/triggers';

function computerSpec(): ConnectorSpec {
  return {
    slug: COMPUTER_SLUG,
    path: `${MANIFEST_FILENAME}#connectors.${COMPUTER_SLUG} (auto: tunnel)`,
    name: computerLabel(),
    enabled: true,
    provider: 'computer',
    credentialMode: 'shared',
    app: null,
    account: null,
    url: null,
    transport: null,
    endpoint: null,
    baseUrl: null,
    platform: null,
    spec: null,
    auth: { type: 'none', in: 'header', name: null, prefix: null, secret: null },
    policies: [],
  };
}

/** True if a `computer` connector (or anything on its slug) is already declared. */
function alreadyDeclared(declared: ConnectorSpec[]): boolean {
  return declared.some((s) => s.slug === COMPUTER_SLUG || s.provider === 'computer');
}

/**
 * A single synthetic `computer` ConnectorSpec when this project's account has a
 * connected machine — never written to git, never shadowing an explicit
 * declaration. Returns `[]` otherwise. Machine presence is the only gate (no
 * experimental flag): it's a regular connector, materialized like Slack.
 */
export async function synthesizeComputerConnectors(
  projectId: string,
  declared: ConnectorSpec[],
): Promise<ConnectorSpec[]> {
  if (alreadyDeclared(declared)) return [];

  const [proj] = await db
    .select({ accountId: projects.accountId })
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);
  if (!proj) return [];

  const [tunnel] = await db
    .select({ tunnelId: tunnelConnections.tunnelId })
    .from(tunnelConnections)
    .where(eq(tunnelConnections.accountId, proj.accountId))
    .limit(1);
  if (!tunnel) return [];

  return [computerSpec()];
}
