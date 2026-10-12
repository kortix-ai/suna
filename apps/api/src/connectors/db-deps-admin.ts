/** Admin reads and writes on one connector: secret binding, policies, config, and the computer-connector profile writes. */
import {
  connectorConnections,
  connectorActions,
  connectors,
  projectSecrets,
  projectSessionConnectorBindings,
} from '@kortix/db';
import { SLUG_RE } from '@kortix/manifest-schema';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { ChannelPlatform } from '../projects/connectors';
import { db } from '../shared/db';
import { validateConnectorSecretBinding } from './connector-secret-binding';
import { credentialExists } from './credentials';
import {
  getConnectorConfigFromManifest,
  getConnectorPoliciesFromManifest,
  setConnectorPoliciesInManifest,
} from './manifest-crud';
import {
  type DefaultMode,
  type EffectiveResolveResult,
  type Policy,
  type PolicyAction,
  isValidMatcher,
  resolveEffectiveAction,
  selectPoliciesForRead,
} from './policy';
import { COMPUTER_SLUG, withComputerCatalog } from './computers';
import { ensureComputerConnector, setMaterializedComputerConnectorPolicies } from './sync';
import {
  authOf,
  baseUrlOf,
  channelPlatform,
  headersOf,
  loadConnectorPoliciesFor,
  loadDefaultModeFor,
  loadProjectPoliciesFor,
} from './db-deps-rows';

/** Which policy scope decided an action — surfaced so the editor can say so. */
type EffectiveSource = EffectiveResolveResult['source'];

export async function setConnectorSecretBinding(
  projectId: string,
  slug: string,
  secretIdentifier: string | null,
) {
  const [connector] = await db
    .select()
    .from(connectors)
    .where(and(eq(connectors.projectId, projectId), eq(connectors.slug, slug)))
    .limit(1);
  if (!connector) return { ok: false as const, error: 'connector not found', status: 404 };

  if (secretIdentifier === null) {
    await db
      .update(connectors)
      .set({ authSecret: null, updatedAt: new Date() })
      .where(eq(connectors.connectorId, connector.connectorId));
    return { ok: true as const };
  }

  const [secret] = await db
    .select({ secretId: projectSecrets.secretId })
    .from(projectSecrets)
    .where(
      and(
        eq(projectSecrets.projectId, projectId),
        eq(projectSecrets.identifier, secretIdentifier),
        isNull(projectSecrets.ownerUserId),
        eq(projectSecrets.active, true),
        eq(projectSecrets.strategy, 'broker'),
        eq(projectSecrets.consumer, 'connector'),
      ),
    )
    .limit(1);
  const validation = validateConnectorSecretBinding({
    secretIdentifier,
    requiresAuth: authOf(connector).hasAuth,
    provider: connector.providerType,
    hasStoredCredential: await credentialExists(connector.connectorId, null),
    secretCompatible: Boolean(secret),
  });
  if (validation) return { ok: false as const, ...validation };

  await db
    .update(connectors)
    .set({ authSecret: secretIdentifier, updatedAt: new Date() })
    .where(eq(connectors.connectorId, connector.connectorId));
  return { ok: true as const };
}

/**
 * Read a connector's per-tool policies for the dashboard/settings surface.
 *
 * Return materialized policy rows when the connector exists in the runtime
 * catalog. The write route commits kortix.yaml and then synchronizes these rows.
 * Reading the manifest again can return a stale git view immediately after the
 * write, which makes the CLI report no rules while the gateway enforces them.
 * Synthetic channel/computer connectors also exist only in the runtime catalog.
 * Use the manifest only when a declared connector has not materialized yet.
 */
export async function getConnectorPolicies(
  projectId: string,
  slug: string,
): Promise<{
  policies: Array<{ match: string; action: string }>;
  effective: Array<{
    path: string;
    action: PolicyAction;
    source: EffectiveSource;
  }>;
  project_policies: Array<{ match: string; action: string }>;
  default_mode: DefaultMode;
} | null> {
  const [fromManifest, [row]] = await Promise.all([
    getConnectorPoliciesFromManifest(projectId, slug),
    db
      .select({
        connectorId: connectors.connectorId,
        config: connectors.config,
        providerType: connectors.providerType,
      })
      .from(connectors)
      .where(and(eq(connectors.projectId, projectId), eq(connectors.slug, slug)))
      .limit(1),
  ]);
  if (!fromManifest && !row) return null;

  const materialized = row
    ? (await loadConnectorPoliciesFor(row.connectorId)).map((p) => ({
        match: p.match,
        action: p.action,
      }))
    : null;
  const policies = selectPoliciesForRead(materialized, fromManifest?.policies ?? null)!;

  // The editor also needs to know WHICH scope decides each tool. A project-scope
  // rule is evaluated first and cannot be overridden here (see policy.ts), so
  // without this the panel would happily show a connector rule the runtime is
  // ignoring. Resolve every action through the same function the call gate uses.
  if (!row) {
    return {
      policies,
      effective: [],
      project_policies: [],
      default_mode: 'allow_all',
    };
  }
  const [projectPolicies, defaultMode, actions] = await Promise.all([
    loadProjectPoliciesFor(projectId),
    loadDefaultModeFor(projectId),
    db
      .select()
      .from(connectorActions)
      .where(eq(connectorActions.connectorId, row.connectorId))
      .then((stored) => withComputerCatalog(row.connectorId, row.providerType, stored)),
  ]);
  const sensitive = (row.config as { sensitive?: unknown } | null)?.sensitive === true;
  const connectorPolicies: Policy[] = policies.map((p) => ({
    match: p.match,
    action: p.action as PolicyAction,
  }));
  const effective = actions.map((a) => {
    const resolved = resolveEffectiveAction({
      fullPath: `${slug}.${a.path}`,
      relPath: a.path,
      projectPolicies,
      connectorPolicies,
      risk: a.risk,
      defaultMode,
      sensitive,
    });
    return { path: a.path, action: resolved.action, source: resolved.source };
  });
  return {
    policies,
    effective,
    project_policies: projectPolicies.map((p) => ({
      match: p.match,
      action: p.action,
    })),
    default_mode: defaultMode,
  };
}

/**
 * Read a connector's definition for the editor. Same manifest-first / DB-fallback
 * rule as getConnectorPolicies: synthetic channel/computer connectors aren't in
 * kortix.yaml, so reconstruct the view from the materialized row instead of 404ing.
 */
export async function getConnectorConfig(
  projectId: string,
  slug: string,
): Promise<Awaited<ReturnType<typeof getConnectorConfigFromManifest>>> {
  const fromManifest = await getConnectorConfigFromManifest(projectId, slug);
  if (fromManifest) return fromManifest;
  const [row] = await db
    .select()
    .from(connectors)
    .where(and(eq(connectors.projectId, projectId), eq(connectors.slug, slug)))
    .limit(1);
  if (!row) return null;
  const cfg = (row.config ?? {}) as Record<string, any>;
  const { auth } = authOf(row);
  return {
    slug: row.slug,
    name: row.name,
    provider: row.providerType,
    platform: channelPlatform(row.config) as ChannelPlatform | null,
    credentialMode: 'shared',
    /** @deprecated Retired; echoed from the manifest so an old editor still parses. */
    authorizationStrategy: row.authorizationStrategy,
    app: cfg.app ?? null,
    account: cfg.account ?? null,
    url: cfg.url ?? null,
    transport: cfg.transport ?? null,
    endpoint: cfg.endpoint ?? null,
    baseUrl: baseUrlOf(row),
    spec: cfg.spec ?? null,
    auth: {
      type: auth.type,
      in: auth.in,
      name: auth.name,
      prefix: auth.prefix,
    },
    headers: headersOf(row),
  };
}

type ConnectorCrudResult = Awaited<ReturnType<typeof setConnectorPoliciesInManifest>>;

async function computerConnectorId(
  projectId: string,
  accountId: string,
  slug: string,
): Promise<string | null> {
  const [row] = await db
    .select({ connectorId: connectors.connectorId })
    .from(connectors)
    .where(
      and(
        eq(connectors.projectId, projectId),
        eq(connectors.accountId, accountId),
        eq(connectors.slug, slug),
        eq(connectors.providerType, 'computer'),
      ),
    )
    .limit(1);
  return row?.connectorId ?? null;
}

export async function setComputerConnectorPolicies(
  projectId: string,
  accountId: string,
  slug: string,
  policies: Array<{ match: string; action: string }>,
): Promise<ConnectorCrudResult | null> {
  const connectorId = await computerConnectorId(projectId, accountId, slug);
  if (!connectorId) return null;

  const allowedActions = new Set<PolicyAction>(['always_run', 'require_approval', 'block']);
  for (const [index, policy] of policies.entries()) {
    if (typeof policy?.match !== 'string' || !policy.match.trim()) {
      return {
        ok: false,
        error: `rule #${index + 1}: \`match\` is required`,
        status: 400,
      };
    }
    if (!isValidMatcher(policy.match.trim())) {
      return {
        ok: false,
        error: `rule #${index + 1}: invalid regex pattern`,
        status: 400,
      };
    }
    if (!allowedActions.has(policy.action as PolicyAction)) {
      return {
        ok: false,
        error: `rule #${index + 1}: \`action\` must be always_run | require_approval | block`,
        status: 400,
      };
    }
  }

  await setMaterializedComputerConnectorPolicies(
    connectorId,
    policies.map((policy) => ({
      match: policy.match.trim(),
      action: policy.action as PolicyAction,
    })),
  );
  return { ok: true };
}

export async function setComputerConnectorSensitive(
  projectId: string,
  accountId: string,
  slug: string,
  sensitive: boolean,
): Promise<ConnectorCrudResult | null> {
  const connectorId = await computerConnectorId(projectId, accountId, slug);
  if (!connectorId) return null;
  const configPatch = sensitive
    ? sql`coalesce(${connectors.config}, '{}'::jsonb) || '{"sensitive": true}'::jsonb`
    : sql`coalesce(${connectors.config}, '{}'::jsonb) - 'sensitive'`;
  await db
    .update(connectors)
    .set({ config: configPatch, updatedAt: new Date() })
    .where(eq(connectors.connectorId, connectorId));
  return { ok: true };
}

/**
 * `provider: computer` on connector create makes (or renames) the project's
 * computer connector. Its accounts are paired machines, added by pairing or by
 * `POST /projects/:id/computers`, never by this draft.
 */
export async function createComputerConnector(
  projectId: string,
  accountId: string,
  draft: Record<string, unknown>,
): Promise<ConnectorCrudResult | null> {
  if (draft.provider !== 'computer') return null;
  const slug = typeof draft.slug === 'string' ? draft.slug.trim() : '';
  if (!SLUG_RE.test(slug)) {
    return { ok: false, error: 'invalid connector slug', status: 400 };
  }
  const name = typeof draft.name === 'string' ? draft.name.trim() : '';
  if (name.length > 255) return { ok: false, error: 'name is too long (max 255)', status: 400 };
  const [existing] = await db
    .select({ providerType: connectors.providerType })
    .from(connectors)
    .where(and(eq(connectors.projectId, projectId), eq(connectors.slug, slug)))
    .limit(1);
  if (existing && (existing.providerType !== 'computer' || draft.create_only === true)) {
    return { ok: false, error: `Connector slug "${slug}" already exists`, status: 409 };
  }
  await ensureComputerConnector(projectId, accountId, { slug, ...(name ? { name } : {}) });
  return { ok: true, sync: { synced: 1, errors: [] } };
}

export async function deleteComputerConnectorProfile(
  projectId: string,
  slug: string,
): Promise<ConnectorCrudResult | null> {
  const [row] = await db
    .select({
      connectorId: connectors.connectorId,
      providerType: connectors.providerType,
    })
    .from(connectors)
    .where(and(eq(connectors.projectId, projectId), eq(connectors.slug, slug)))
    .limit(1);
  if (!row || row.providerType !== 'computer') return null;
  // F1: the built-in computer connector (the one ensureProjectComputer picks)
  // is never removable. Deleting it cascades to every account on it, and the
  // project-shared ones would never come back. A legacy extra profile goes
  // only while no machine is attached to it.
  const [builtIn] = await db
    .select({ connectorId: connectors.connectorId })
    .from(connectors)
    .where(and(eq(connectors.projectId, projectId), eq(connectors.providerType, 'computer')))
    .orderBy(sql`${connectors.slug} = ${COMPUTER_SLUG} desc`, connectors.createdAt)
    .limit(1);
  if (builtIn?.connectorId === row.connectorId) {
    return { ok: false, error: 'The built-in computer connector cannot be removed. Unpair or revoke a computer instead.', status: 409 };
  }
  const [attached] = await db
    .select({ one: sql`1` })
    .from(connectorConnections)
    .where(and(eq(connectorConnections.connectorId, row.connectorId), isNotNull(connectorConnections.tunnelId)))
    .limit(1);
  if (attached) {
    return { ok: false, error: 'This computer connector still has computers attached. Unpair or revoke them first.', status: 409 };
  }
  await db.transaction(async (tx) => {
    await tx
      .delete(projectSessionConnectorBindings)
      .where(eq(projectSessionConnectorBindings.connectorId, row.connectorId));
    await tx.delete(connectors).where(eq(connectors.connectorId, row.connectorId));
  });
  return { ok: true };
}

export async function setComputerConnectorName(
  projectId: string,
  accountId: string,
  slug: string,
  name: string,
): Promise<ConnectorCrudResult | null> {
  const connectorId = await computerConnectorId(projectId, accountId, slug);
  if (!connectorId) return null;
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: 'name is required', status: 400 };
  if (trimmed.length > 255) {
    return { ok: false, error: 'name is too long (max 255)', status: 400 };
  }
  await db
    .update(connectors)
    .set({ name: trimmed, updatedAt: new Date() })
    .where(eq(connectors.connectorId, connectorId));
  return { ok: true };
}
