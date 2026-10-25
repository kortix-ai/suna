/** Admin reads and writes on one connector: secret binding, policies, config, and the computer-connector profile writes. */
import {
  connectorConnections,
  connectorActions,
  connectorPolicySets,
  connectors,
  projectSecrets,
  projectSessionConnectorBindings,
} from '@kortix/db';
import { SLUG_RE } from '@kortix/manifest-schema';
import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { ChannelPlatform } from '../projects/connectors';
import { db } from '../shared/db';
import { validateConnectorSecretBinding } from './connector-secret-binding';
import { commitConnectorAuthSecret } from './manifest-auth-secret';
import { credentialExists } from './credentials';
import {
  getConnectorConfigFromManifest,
  getConnectorPoliciesFromManifest,
  listConnectorPolicySetsFromManifest,
  setConnectorPoliciesInManifest,
} from './manifest-crud';
import {
  type DefaultMode,
  type EffectiveResolveResult,
  type Policy,
  type PolicyAction,
  type PolicyArgCondition,
  isValidMatcher,
  resolveEffectiveRule,
  selectPoliciesForRead,
} from './policy';
import { COMPUTER_SLUG, withComputerCatalog } from './computers';
import {
  ensureComputerConnector,
  rematerializeCatalogAfterCredentialUpdate,
  setMaterializedComputerConnectorPolicies,
} from './sync';
import {
  authOf,
  baseUrlOf,
  channelPlatform,
  headersOf,
  loadConnectorPoliciesFor,
  loadConnectorPolicySetFor,
  policiesOfStoredSet,
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
    const declared = await commitConnectorAuthSecret(projectId, slug, null);
    if (!declared.ok) return { ok: false as const, error: declared.error, status: declared.status as 404 | 409 };
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

  // kortix.yaml owns connectors[].auth.secret: commit it first, so a later
  // sync applies the same value and the file never disagrees with the row.
  const declared = await commitConnectorAuthSecret(projectId, slug, secretIdentifier);
  if (!declared.ok) return { ok: false as const, error: declared.error, status: declared.status as 404 | 409 };
  await db
    .update(connectors)
    .set({ authSecret: secretIdentifier, updatedAt: new Date() })
    .where(eq(connectors.connectorId, connector.connectorId));
  // Same as storing a credential: an MCP connector re-lists its tools with it now.
  const sync = await rematerializeCatalogAfterCredentialUpdate({
    projectId,
    accountId: connector.accountId,
    provider: connector.providerType,
    ownerType: 'project',
    isDefault: true,
  });
  return { ok: true as const, ...(sync ? { sync } : {}) };
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
  policySet?: string | null,
): Promise<
  | {
      policies: ApiRule[];
      /** The set these rules belong to; absent for the base rules. */
      policy_set?: string;
      effective: Array<{
        path: string;
        action: PolicyAction;
        source: EffectiveSource;
        /** The stored risk the project default decides on. */
        risk?: string;
        /** The rule that decided; absent when the default did. */
        rule?: ApiRule;
      }>;
      /** Marked sensitive: every tool no rule decides needs approval. */
      sensitive?: boolean;
      project_policies: Array<{ match: string; action: string }>;
      default_mode: DefaultMode;
    }
  | { error: string; code: 'policy_set_not_found' }
  | null
> {
  const [fromManifest, [row]] = await Promise.all([
    getConnectorPoliciesFromManifest(projectId, slug, policySet),
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

  const materializedBase = row ? (await loadConnectorPoliciesFor(row.connectorId)).map(apiRule) : null;
  const base = policySet
    ? materializedBase ?? (await getConnectorPoliciesFromManifest(projectId, slug))?.policies ?? []
    : selectPoliciesForRead(materializedBase, fromManifest?.policies ?? null)!;
  // A set's rules: the materialized row when the connector is synced (a git
  // read can lag the commit), the manifest otherwise.
  let setRules: ApiRule[] | null = null;
  if (policySet) {
    const stored = row ? await loadConnectorPolicySetFor(row.connectorId, policySet) : null;
    setRules = stored
      ? stored.map(apiRule)
      : fromManifest?.policySetFound
        ? fromManifest.policies
        : null;
    if (!setRules) {
      return { error: `connector "${slug}" has no policy set "${policySet}"`, code: 'policy_set_not_found' };
    }
  }
  const policies = setRules ?? base;
  const setView = policySet ? { policy_set: policySet } : {};

  // The editor also needs to know WHICH scope decides each tool. A project-scope
  // rule is evaluated first and cannot be overridden here (see policy.ts), so
  // without this the panel would happily show a connector rule the runtime is
  // ignoring. Resolve every action through the same function the call gate
  // uses — for a set, as an agent holding that set would be resolved.
  if (!row) {
    return {
      policies,
      ...setView,
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
  const effective = actions.map((a) => {
    const resolved = resolveEffectiveRule({
      fullPath: `${slug}.${a.path}`,
      relPath: a.path,
      projectPolicies,
      setPolicies: setRules ? setRules.map(enginePolicy) : undefined,
      connectorPolicies: base.map(enginePolicy),
      risk: a.risk,
      defaultMode,
      sensitive,
    });
    // `risk`: the stored risk the default decided on. `rule`: the rule that
    // decided, when one did (`conditions`: it decides only for matching args).
    return {
      path: a.path,
      action: resolved.action,
      source: resolved.source,
      risk: a.risk,
      ...(resolved.rule
        ? {
            rule: {
              match: resolved.rule.match,
              action: resolved.rule.action,
              ...(resolved.rule.conditions?.length ? { conditions: resolved.rule.conditions } : {}),
            },
          }
        : {}),
    };
  });
  return {
    policies,
    ...setView,
    effective,
    sensitive,
    project_policies: projectPolicies.map((p) => ({
      match: p.match,
      action: p.action,
    })),
    default_mode: defaultMode,
  };
}

/**
 * Channel and computer connectors cannot carry policy sets: computer and
 * synthetic channel connectors have no manifest entry, and sync never writes
 * their rules back to git. Returns the 400 to answer, or null.
 */
export async function policySetsUnsupportedFor(projectId: string, slug: string) {
  const [row] = await db
    .select({ providerType: connectors.providerType })
    .from(connectors)
    .where(and(eq(connectors.projectId, projectId), eq(connectors.slug, slug)))
    .limit(1);
  if (row?.providerType !== 'channel' && row?.providerType !== 'computer') return null;
  const error = `${row.providerType} connectors cannot carry policy sets`;
  return { ok: false as const, error, status: 400, body: { error, code: 'policy_sets_unsupported' } };
}

/** A rule as the policy API answers it: conditions kept when present. */
type ApiRule = { match: string; action: PolicyAction; conditions?: PolicyArgCondition[] | null };

function apiRule(p: { match: string; action: PolicyAction; conditions?: PolicyArgCondition[] | null }): ApiRule {
  return {
    match: p.match,
    action: p.action,
    ...(p.conditions && p.conditions.length > 0 ? { conditions: p.conditions } : {}),
  };
}

function enginePolicy(p: ApiRule, position: number): Policy {
  return { match: p.match, action: p.action, position, conditions: p.conditions ?? null };
}

/**
 * The sets of one connector, each with its rules and the agents that use it.
 * Rules and descriptions come from the materialized rows when the connector
 * is synced (the git view can lag a write), the manifest otherwise; agent
 * usage comes from the manifest, the only place assignments live.
 */
export async function listConnectorPolicySets(
  projectId: string,
  slug: string,
): Promise<{
  sets: Array<{ name: string; description: string | null; policies: ApiRule[]; agents: string[] }>;
} | null> {
  const [fromManifest, [row]] = await Promise.all([
    listConnectorPolicySetsFromManifest(projectId, slug),
    db
      .select({ connectorId: connectors.connectorId })
      .from(connectors)
      .where(and(eq(connectors.projectId, projectId), eq(connectors.slug, slug)))
      .limit(1),
  ]);
  if (!fromManifest && !row) return null;
  const agentsOf = (name: string) =>
    fromManifest && Object.hasOwn(fromManifest.agents, name) ? fromManifest.agents[name]! : [];
  if (row) {
    const stored = await db
      .select()
      .from(connectorPolicySets)
      .where(eq(connectorPolicySets.connectorId, row.connectorId))
      .orderBy(asc(connectorPolicySets.createdAt), asc(connectorPolicySets.name));
    if (stored.length > 0 || !fromManifest) {
      return {
        sets: stored.map((set) => ({
          name: set.name,
          description: set.description,
          policies: (policiesOfStoredSet(set.policies) ?? []).map(apiRule),
          agents: agentsOf(set.name),
        })),
      };
    }
  }
  return { sets: (fromManifest?.sets ?? []).map((set) => ({ ...set, policies: set.policies.map((p) => apiRule(p)), agents: agentsOf(set.name) })) };
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
      // `path` exists only on platform-owned channel connectors (Telegram), which
      // nobody edits; the manifest editor's contract knows header/query/cookie.
      in: auth.in === 'path' ? 'header' : auth.in,
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
