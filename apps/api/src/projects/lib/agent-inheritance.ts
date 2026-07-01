import { projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import type { GrantSet } from '../agents';
import { isResourceExplicitlyGranted, loadProjectResourceGrants } from '../../iam/resource-grants';
import { db } from '../../shared/db';
import { loadConfigWithFiles } from './project-resources';

/**
 * The "assign human → agent" pyramid, read side. A member/department assigned to
 * an agent (an agent resource grant) inherits EVERYTHING that agent declares in
 * kortix.toml — its `env` secrets and `connectors` — as their own accessible
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
 * Pure union of the CONCRETE env/connector allowlists declared by the `assigned`
 * agents. `'all'` contributes nothing concrete — it already means "everything the
 * launcher can see," so there is no specific name to inherit — only explicit lists
 * are inheritable. De-duplicated across agents.
 */
export function unionDeclaredResources(
  agents: ReadonlyArray<{ name: string; env?: GrantSet; connectors?: GrantSet }>,
  assigned: ReadonlySet<string>,
): { secrets: string[]; connectors: string[] } {
  const secrets = new Set<string>();
  const connectors = new Set<string>();
  for (const a of agents) {
    if (!assigned.has(a.name)) continue;
    if (Array.isArray(a.env)) for (const s of a.env) secrets.add(s);
    if (Array.isArray(a.connectors)) for (const c of a.connectors) connectors.add(c);
  }
  return { secrets: [...secrets], connectors: [...connectors] };
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
): Promise<{ secrets: string[]; connectors: string[] }> {
  const assigned = await resolveAssignedAgentNames(row.projectId, userId, groupIds);
  if (assigned.size === 0) return { secrets: [], connectors: [] };

  const config = await loadConfigWithFiles(row).catch(() => null);
  if (!config) return { secrets: [], connectors: [] };

  return unionDeclaredResources(
    config.agents.map((a) => ({ name: a.name, env: a.scope?.env, connectors: a.scope?.connectors })),
    assigned,
  );
}

/**
 * Executor-side entry point: the connector slugs the subject inherits via the
 * agents they're assigned to. Loads the project row itself (the executor gate
 * only has a projectId), so it can read [[agents]] from git. Fail-closed —
 * inheritance only ADDS access, so any error resolves to the empty set and the
 * direct share check stands.
 */
export async function resolveInheritedConnectorSlugs(
  projectId: string,
  userId: string,
  groupIds: readonly string[],
): Promise<Set<string>> {
  try {
    const [row] = await db.select().from(projects).where(eq(projects.projectId, projectId)).limit(1);
    if (!row) return new Set();
    const { connectors } = await resolveInheritedResourceNames(row, userId, groupIds);
    return new Set(connectors);
  } catch {
    return new Set();
  }
}
