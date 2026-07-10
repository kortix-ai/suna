import type { GrantSet } from '../agents';
import { isResourceExplicitlyGranted, loadProjectResourceGrants } from '../../iam/resource-grants';
import { loadConfigWithFiles } from './project-resources';

/**
 * The "assign human → agent" pyramid, read side. A member/department assigned to
 * an agent (an agent resource grant) inherits EVERYTHING that agent declares in
 * kortix.yaml — its `env` secrets and `connectors` — as their own accessible
 * resources everywhere (the Secrets UI, any session, connector calls). No opt-in
 * flag: the assignment itself does it.
 */

/**
 * Which agents is this subject EXPLICITLY assigned to (an agent resource grant
 * names them or one of their departments)? This set drives all inheritance.
 * Unscoped agents grant no one anything — an explicit assignment is required.
 */
export async function resolveAssignedAgentNames(
  projectId: string,
  userId: string,
  groupIds: readonly string[],
): Promise<Set<string>> {
  const grants = await loadProjectResourceGrants(projectId, 'agent');
  const assigned = new Set<string>();
  for (const [agentName, principals] of grants) {
    if (isResourceExplicitlyGranted(principals, userId, groupIds)) assigned.add(agentName);
  }
  return assigned;
}

/**
 * The result of unioning declared resources across assigned agents. The `secrets`
 * / `connectors` arrays are the de-duplicated names (what most callers need); the
 * `*Sources` maps carry PROVENANCE — name → the assigned agents that declare it —
 * so the UI can answer "you inherit STRIPE_KEY from agent `billing-bot`."
 */
export interface DeclaredResourceUnion {
  secrets: string[];
  connectors: string[];
  /** secret name → assigned agents that declare it (order = first-seen). */
  secretSources: Map<string, string[]>;
  /** connector slug → assigned agents that declare it. */
  connectorSources: Map<string, string[]>;
}

/** Fresh empty union — a factory, NOT a shared singleton, so a caller that reads
 *  (or accidentally mutates) the returned maps can never corrupt a later call. */
function emptyUnion(): DeclaredResourceUnion {
  return { secrets: [], connectors: [], secretSources: new Map(), connectorSources: new Map() };
}

function addSource(map: Map<string, string[]>, key: string, agent: string): void {
  const existing = map.get(key);
  if (existing) {
    if (!existing.includes(agent)) existing.push(agent);
  } else {
    map.set(key, [agent]);
  }
}

/**
 * Pure union of the CONCRETE env/connector allowlists declared by the `assigned`
 * agents, WITH provenance. `'all'` contributes nothing concrete — it already means
 * "everything the launcher can see," so there is no specific name to inherit —
 * only explicit lists are inheritable. De-duplicated across agents; each name
 * keeps the list of agents that contributed it.
 */
export function unionDeclaredResources(
  agents: ReadonlyArray<{ name: string; env?: GrantSet; connectors?: GrantSet }>,
  assigned: ReadonlySet<string>,
): DeclaredResourceUnion {
  const secretSources = new Map<string, string[]>();
  const connectorSources = new Map<string, string[]>();
  for (const a of agents) {
    if (!assigned.has(a.name)) continue;
    if (Array.isArray(a.env)) for (const s of a.env) addSource(secretSources, s, a.name);
    if (Array.isArray(a.connectors)) for (const c of a.connectors) addSource(connectorSources, c, a.name);
  }
  return {
    secrets: [...secretSources.keys()],
    connectors: [...connectorSources.keys()],
    secretSources,
    connectorSources,
  };
}

/**
 * Resolve the union of {env, connectors} declared by the agents the user is
 * assigned to, from the project's git config. Fast-paths to empty when the user
 * has no agent assignments (the common case) — only then does it pay the config
 * read. Used by the read surfaces that already hold a ProjectRow (the Secrets
 * list, connector visibility). The runtime session path builds the same union
 * from the lighter `loadProjectAgents` specs instead.
 */
export async function resolveInheritedResourceNames(
  row: Parameters<typeof loadConfigWithFiles>[0] & { projectId: string },
  userId: string,
  groupIds: readonly string[],
): Promise<DeclaredResourceUnion> {
  const assigned = await resolveAssignedAgentNames(row.projectId, userId, groupIds);
  if (assigned.size === 0) return emptyUnion();

  const config = await loadConfigWithFiles(row).catch(() => null);
  if (!config) return emptyUnion();

  return unionDeclaredResources(
    config.agents.map((a) => ({ name: a.name, env: a.scope?.env, connectors: a.scope?.connectors })),
    assigned,
  );
}
