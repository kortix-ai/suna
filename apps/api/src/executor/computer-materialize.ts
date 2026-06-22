/**
 * Auto-materialize the `computer` connector from connected machines.
 *
 * Like the `channel` connector, `computer` needs no `[[connectors]]` entry —
 * connecting a machine over the Agent Computer Tunnel IS the registration. When
 * a project's account has at least one tunnel (and the project has opted into the
 * `agent_tunnel` experimental flag), we synthesize a SINGLE `computer`
 * ConnectorSpec here so the materializer treats it like any other connector (DB
 * rows, the fixed action catalog, sharing, policies, and the Executor/Connectors
 * surface). One connector fronts ALL the account's machines — the machine is a
 * call argument, resolved at call time. There is no credential: the live WS
 * relay is the credential, and per-machine auth/scope is the tunnel permission
 * layer. See docs/specs/computer-connector.md.
 */
import { eq } from 'drizzle-orm';
import { projects, tunnelConnections } from '@kortix/db';
import { db } from '../shared/db';
import { resolveExperimentalFeature } from '../experimental/features';
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
 * connected machine and the project has the `agent_tunnel` flag — never written
 * to git, never shadowing an explicit declaration. Returns `[]` otherwise.
 */
export async function synthesizeComputerConnectors(
  projectId: string,
  declared: ConnectorSpec[],
): Promise<ConnectorSpec[]> {
  if (alreadyDeclared(declared)) return [];

  const [proj] = await db
    .select({ accountId: projects.accountId, metadata: projects.metadata })
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);
  if (!proj) return [];

  // Gated by the experimental flag — computers only surface as connectors for
  // projects opted into the tunnel.
  if (!resolveExperimentalFeature(proj.metadata, 'agent_tunnel')) return [];

  const [tunnel] = await db
    .select({ tunnelId: tunnelConnections.tunnelId })
    .from(tunnelConnections)
    .where(eq(tunnelConnections.accountId, proj.accountId))
    .limit(1);
  if (!tunnel) return [];

  return [computerSpec()];
}
