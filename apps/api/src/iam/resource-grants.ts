/**
 * IAM V2 per-RESOURCE scoping — engine + repository for iam_resource_grants.
 *
 * Scopes a member or group (Department) to a SPECIFIC agent or skill within a
 * project. This is the layer that answers "Marketing may use agent
 * `outreach-bot` and skill `lead-research`, nothing else." It sits as an
 * INTERSECTION on top of the project-role / custom-policy verdict in
 * authorizeV2.
 *
 * Semantics — RESOURCE-ID-LEVEL activation (deliberately opt-in, no lockouts):
 *   - A resource (agent name / skill slug) becomes "scoped" once >=1 grant row
 *     exists for (project, resource_type, resource_id).
 *   - UNSCOPED resources (no grant rows) stay project-wide — scoping agent A
 *     restricts only agent A; agents B/C with no grant stay open to anyone who
 *     holds the capability. So creating the first grant never silently locks a
 *     department out of everything else.
 *   - SCOPED resources are accessible ONLY to principals with a matching grant:
 *     a member grant for the user, or a group grant for any group the user is
 *     in. Account owners/admins keep implicit Manager and bypass scoping; the
 *     fold runs for human members only (service accounts are governed by their
 *     own policies + agentGrant).
 *
 * Cache: a project+type keyed memo (~15s TTL) holds the grant map; mutations
 * bust it synchronously on the writing replica (invalidateIamCacheForProject-
 * Resources), with the same <=TTL cross-replica lag the rest of the IAM cache
 * already accepts. The empty (unscoped) map IS cached — that's the common,
 * hot-path case — and every mutation busts it.
 *
 * Import direction: this module imports cache-invalidation (register/bust) but
 * NOT engine-v2; engine-v2 imports this. No cycle.
 */
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { iamResourceGrants } from '@kortix/db';
import { db } from '../shared/db';
import { ttlMemo } from '../shared/ttl-memo';
import {
  invalidateIamCacheForProjectResources,
  registerProjectScopedMemo,
} from './cache-invalidation';

/** The resource kinds that support per-resource scoping today. Extensible.
 *  agent/skill ids come from the git config; secret ids are the secret NAME
 *  (uppercased key) from the project_secrets table. */
export const RESOURCE_GRANT_TYPES = ['agent', 'skill', 'secret'] as const;
export type ResourceType = (typeof RESOURCE_GRANT_TYPES)[number];
export function isResourceType(v: string): v is ResourceType {
  return (RESOURCE_GRANT_TYPES as readonly string[]).includes(v);
}

export type PrincipalType = 'member' | 'group';

interface ResourceGrantPrincipal {
  principalType: PrincipalType;
  principalId: string;
}

// Mirror engine-v2's IAM_CACHE_TTL_MS read locally (can't import it without an
// engine-v2 → resource-grants → engine-v2 cycle).
const TTL_MS = (() => {
  const raw = Number(process.env.IAM_CACHE_TTL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 15_000;
})();

/**
 * PURE. Is THIS resource accessible to a principal (userId + their group ids),
 * given the grant rows for that one (project, type, resourceId)?
 * - undefined/empty grants → accessible (unscoped resource = project-wide).
 * - has grants → accessible iff one matches the user or one of their groups.
 * Unit-tested directly (no DB) like the other pure engine helpers.
 */
export function isResourceAccessible(
  grantsForResource: ResourceGrantPrincipal[] | undefined,
  userId: string,
  groupIds: readonly string[],
): boolean {
  if (!grantsForResource || grantsForResource.length === 0) return true;
  const groups = new Set(groupIds);
  for (const g of grantsForResource) {
    if (g.principalType === 'member' && g.principalId === userId) return true;
    if (g.principalType === 'group' && groups.has(g.principalId)) return true;
  }
  return false;
}

/**
 * PURE. Is this principal EXPLICITLY assigned to the resource? Unlike
 * `isResourceAccessible`, an UNSCOPED resource (no grants) means "NOT assigned"
 * (false), not "open to everyone". Gates agent-resource inheritance: inheriting
 * an agent's secrets requires a deliberate assignment, never the default-open
 * state — so declaring `inherit` on an unscoped agent grants nobody anything.
 */
export function isResourceExplicitlyGranted(
  grantsForResource: ResourceGrantPrincipal[] | undefined,
  userId: string,
  groupIds: readonly string[],
): boolean {
  if (!grantsForResource || grantsForResource.length === 0) return false;
  const groups = new Set(groupIds);
  for (const g of grantsForResource) {
    if (g.principalType === 'member' && g.principalId === userId) return true;
    if (g.principalType === 'group' && groups.has(g.principalId)) return true;
  }
  return false;
}

export async function isProjectResourceExplicitlyGranted(
  projectId: string,
  resourceType: ResourceType,
  resourceId: string,
  userId: string,
  groupIds: readonly string[],
): Promise<boolean> {
  const map = await loadProjectResourceGrants(projectId, resourceType);
  return isResourceExplicitlyGranted(map.get(resourceId), userId, groupIds);
}

/**
 * project+type keyed map: resourceId → granted principals (non-expired allows).
 * Memoized; the empty map is cached too (the common unscoped case) and busted on
 * mutation. Registered as a project-scoped memo so a grant change drops it.
 */
const loadProjectResourceGrants = ttlMemo({
  ttlMs: TTL_MS,
  keyFn: (projectId: string, resourceType: string) => `${projectId}|${resourceType}`,
  loader: async (projectId: string, resourceType: string) => {
    const rows = await db
      .select({
        resourceId: iamResourceGrants.resourceId,
        principalType: iamResourceGrants.principalType,
        principalId: iamResourceGrants.principalId,
      })
      .from(iamResourceGrants)
      .where(
        and(
          eq(iamResourceGrants.projectId, projectId),
          eq(iamResourceGrants.resourceType, resourceType),
          eq(iamResourceGrants.effect, 'allow'),
          or(isNull(iamResourceGrants.expiresAt), gt(iamResourceGrants.expiresAt, sql`now()`)),
        ),
      );
    const map = new Map<string, ResourceGrantPrincipal[]>();
    for (const r of rows) {
      const entry: ResourceGrantPrincipal = {
        principalType: r.principalType as PrincipalType,
        principalId: r.principalId,
      };
      const list = map.get(r.resourceId);
      if (list) list.push(entry);
      else map.set(r.resourceId, [entry]);
    }
    return map;
  },
  shouldCache: () => true,
});
registerProjectScopedMemo(loadProjectResourceGrants);

export { loadProjectResourceGrants };

/**
 * Cheap memoized gate: does this project scope ANY agent or skill? Lets read
 * paths (file routes, pickers) skip the whole denied-path computation — and the
 * config load it needs — in the common case where nothing is scoped. Two memo
 * hits, no DB round-trip on the hot path once warm.
 */
export async function hasAnyResourceGrants(projectId: string): Promise<boolean> {
  const [agents, skills] = await Promise.all([
    loadProjectResourceGrants(projectId, 'agent'),
    loadProjectResourceGrants(projectId, 'skill'),
  ]);
  return agents.size > 0 || skills.size > 0;
}

/**
 * Of `resourceIds`, the ones with NO grant (unscoped = project-wide). Used to
 * show an unidentified caller (e.g. a not-logged-in Slack user) only the
 * project-wide agents/skills, never a scoped one's name.
 */
export async function unscopedResourceIds(
  projectId: string,
  resourceType: ResourceType,
  resourceIds: readonly string[],
): Promise<string[]> {
  const map = await loadProjectResourceGrants(projectId, resourceType);
  return resourceIds.filter((id) => !map.has(id));
}

/** Engine entry point: is (project, type, resourceId) accessible to this member? */
export async function isProjectResourceAccessible(
  projectId: string,
  resourceType: ResourceType,
  resourceId: string,
  userId: string,
  groupIds: readonly string[],
): Promise<boolean> {
  const map = await loadProjectResourceGrants(projectId, resourceType);
  return isResourceAccessible(map.get(resourceId), userId, groupIds);
}

/**
 * Filter a list of resource ids to the ones this member can access — used to
 * hide ungranted agents/skills from the project config the UI renders. Returns
 * the input order. One memo hit for the whole list.
 */
export async function filterAccessibleResourceIds(
  projectId: string,
  resourceType: ResourceType,
  resourceIds: readonly string[],
  userId: string,
  groupIds: readonly string[],
): Promise<string[]> {
  const map = await loadProjectResourceGrants(projectId, resourceType);
  return resourceIds.filter((id) => isResourceAccessible(map.get(id), userId, groupIds));
}

// ─── Repository (CRUD) ──────────────────────────────────────────────────────

interface ResourceGrantRow {
  grantId: string;
  resourceType: string;
  resourceId: string;
  principalType: string;
  principalId: string;
  expiresAt: Date | null;
  grantedBy: string | null;
  createdAt: Date;
}

/** Every grant for a project (for the Members UI). */
export async function listResourceGrants(projectId: string): Promise<ResourceGrantRow[]> {
  return db
    .select({
      grantId: iamResourceGrants.grantId,
      resourceType: iamResourceGrants.resourceType,
      resourceId: iamResourceGrants.resourceId,
      principalType: iamResourceGrants.principalType,
      principalId: iamResourceGrants.principalId,
      expiresAt: iamResourceGrants.expiresAt,
      grantedBy: iamResourceGrants.grantedBy,
      createdAt: iamResourceGrants.createdAt,
    })
    .from(iamResourceGrants)
    .where(eq(iamResourceGrants.projectId, projectId));
}

/** Create or update a grant (idempotent on the unique principal+resource key). */
export async function upsertResourceGrant(input: {
  accountId: string;
  projectId: string;
  resourceType: ResourceType;
  resourceId: string;
  principalType: PrincipalType;
  principalId: string;
  grantedBy: string;
  /** undefined = leave as-is on update / NULL on insert; null = clear; Date = set. */
  expiresAt?: Date | null | undefined;
}): Promise<{ grantId: string }> {
  const now = new Date();
  const [row] = await db
    .insert(iamResourceGrants)
    .values({
      accountId: input.accountId,
      projectId: input.projectId,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      principalType: input.principalType,
      principalId: input.principalId,
      effect: 'allow',
      expiresAt: input.expiresAt ?? null,
      grantedBy: input.grantedBy,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        iamResourceGrants.projectId,
        iamResourceGrants.resourceType,
        iamResourceGrants.resourceId,
        iamResourceGrants.principalType,
        iamResourceGrants.principalId,
      ],
      set: {
        grantedBy: input.grantedBy,
        updatedAt: now,
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      },
    })
    .returning({ grantId: iamResourceGrants.grantId });
  invalidateIamCacheForProjectResources(input.projectId);
  return { grantId: row.grantId };
}

/** Delete a grant by id (scoped to the project so a stray id can't cross over). */
export async function deleteResourceGrant(grantId: string, projectId: string): Promise<boolean> {
  const deleted = await db
    .delete(iamResourceGrants)
    .where(and(eq(iamResourceGrants.grantId, grantId), eq(iamResourceGrants.projectId, projectId)))
    .returning({ grantId: iamResourceGrants.grantId });
  invalidateIamCacheForProjectResources(projectId);
  return deleted.length > 0;
}
