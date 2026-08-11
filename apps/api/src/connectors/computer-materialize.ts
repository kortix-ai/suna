/**
 * Materialize platform-managed Computers connector profiles.
 *
 * Pairing a tunnel only adds it to the account fleet. It does not grant a
 * project access. A Computers connector profile is created explicitly through
 * the connector API and stores one or more selected tunnel ids in its DB config.
 * The normal connector row owns grants, policies, audit, and session exposure.
 *
 * Profiles never live in kortix.yaml because tunnel ids are account control-
 * plane identities, not repository configuration. This synthesizer reads the
 * stored profiles back into the normal materializer during connector sync.
 *
 * Compatibility: PR #6287 briefly created one `computer-<uuid>` row per
 * machine. The next sync folds those generated rows into one `computer`
 * profile. Explicit profiles carry `computer_profile=true` and are preserved.
 */
import { connectors, projects, tunnelConnections } from '@kortix/db';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';

import type { ConnectorSpec } from '../workspaces/connectors';
import { MANIFEST_FILENAME } from '../workspaces/triggers';
import { db } from '../shared/db';
import { COMPUTER_SLUG, computerLabel } from './computers';

export function computerProfileSpec(input: {
  slug: string;
  name: string;
  tunnelIds: string[];
  tunnelAccountIds: string[];
  sensitive?: boolean;
}): ConnectorSpec {
  return {
    slug: input.slug,
    path: `${MANIFEST_FILENAME}#connectors.${input.slug} (platform: computers)`,
    name: input.name,
    enabled: true,
    provider: 'computer',
    credentialMode: 'shared',
    authorizationStrategy: 'project',
    sensitive: input.sensitive === true,
    app: null,
    account: null,
    url: null,
    transport: null,
    endpoint: null,
    baseUrl: null,
    platform: null,
    spec: null,
    tunnelIds: [...new Set(input.tunnelIds)],
    tunnelAccountIds: [...new Set(input.tunnelAccountIds)],
    auth: {
      type: 'none',
      in: 'header',
      name: null,
      prefix: null,
      secret: null,
    },
    headers: {},
    policies: [],
  };
}

function storedTunnelIds(configValue: unknown): string[] | null {
  const config = (configValue ?? {}) as Record<string, unknown>;
  if (Array.isArray(config.tunnel_ids)) {
    return [
      ...new Set(config.tunnel_ids.filter((value): value is string => typeof value === 'string')),
    ];
  }
  if (typeof config.tunnel_id === 'string') return [config.tunnel_id];
  return null;
}

function storedTunnelAccountIds(configValue: unknown, fallbackAccountId: string): string[] {
  const config = (configValue ?? {}) as Record<string, unknown>;
  if (Array.isArray(config.tunnel_account_ids)) {
    return [
      ...new Set(
        config.tunnel_account_ids.filter(
          (value): value is string => typeof value === 'string' && value.length > 0,
        ),
      ),
    ];
  }
  return [fallbackAccountId];
}

function isExplicitProfile(configValue: unknown): boolean {
  const config = (configValue ?? {}) as Record<string, unknown>;
  return config.computer_profile === true && Array.isArray(config.tunnel_ids);
}

/**
 * Return every explicit DB-backed Computers profile for normal materialization.
 * No tunnel row means no implicit connector. Workspace access begins only after a
 * connector profile is created.
 */
export async function synthesizeComputerConnectors(
  workspaceId: string,
  declared: ConnectorSpec[],
): Promise<ConnectorSpec[]> {
  const [proj] = await db
    .select({ accountId: projects.accountId })
    .from(projects)
    .where(eq(projects.workspaceId, workspaceId))
    .limit(1);
  if (!proj) return [];

  const rows = await db
    .select({
      slug: connectors.slug,
      name: connectors.name,
      config: connectors.config,
    })
    .from(connectors)
    .where(and(eq(connectors.workspaceId, workspaceId), eq(connectors.providerType, 'computer')));
  if (rows.length === 0) return [];

  const declaredSlugs = new Set(declared.map((spec) => spec.slug));
  const explicit = rows
    .filter((row) => isExplicitProfile(row.config))
    .map((row) =>
      computerProfileSpec({
        slug: row.slug,
        name: row.name,
        tunnelIds: storedTunnelIds(row.config) ?? [],
        tunnelAccountIds: storedTunnelAccountIds(row.config, proj.accountId),
        sensitive: (row.config as { sensitive?: unknown } | null)?.sensitive === true,
      }),
    )
    .filter((spec) => !declaredSlugs.has(spec.slug));
  if (explicit.length > 0) return explicit;

  // Fold the short-lived per-machine model into one regular profile. Only
  // account-owned machines that completed a handshake can enter the migration.
  const legacyIds = [...new Set(rows.flatMap((row) => storedTunnelIds(row.config) ?? []))];
  const accountTunnels = await db
    .select({ tunnelId: tunnelConnections.tunnelId })
    .from(tunnelConnections)
    .where(
      and(
        eq(tunnelConnections.accountId, proj.accountId),
        isNotNull(tunnelConnections.lastHeartbeatAt),
        ...(legacyIds.length > 0 ? [inArray(tunnelConnections.tunnelId, legacyIds)] : []),
      ),
    );
  const tunnelIds = accountTunnels.map((row) => row.tunnelId);
  if (tunnelIds.length === 0 || declaredSlugs.has(COMPUTER_SLUG)) return [];
  const aggregate = rows.find((row) => row.slug === COMPUTER_SLUG);
  return [
    computerProfileSpec({
      slug: COMPUTER_SLUG,
      name: aggregate?.name || computerLabel(),
      tunnelIds,
      tunnelAccountIds: [proj.accountId],
      sensitive: (aggregate?.config as { sensitive?: unknown } | null)?.sensitive === true,
    }),
  ];
}
