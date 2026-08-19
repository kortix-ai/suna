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
 * AGENT-ONLY member-scoped resource (Marko, resource-model simplification):
 * only `agent` is a member/department-scopable resource going forward. Skills
 * and secrets are governed by the EDITOR role (edit) + agent inheritance (use)
 * instead — assigning an agent to a member lets them USE what that agent
 * declares (its skills/connectors/secrets), never edit it. `skill` and
 * `secret` stay in RESOURCE_GRANT_TYPES / ResourceType purely for back-compat:
 * pre-existing grant rows of those types must keep reading, listing, and
 * revoking correctly. NEW grants of those types are rejected at the API layer
 * (see CREATABLE_RESOURCE_GRANT_TYPES + the routes/resource-grants.ts POST gate)
 * — this module stays permissive so it never has to know which caller is
 * enforcing that; it's a write-time policy, not a storage-model change.
 *
 * Import direction: this module imports cache-invalidation (register/bust) but
 * NOT engine-v2; engine-v2 imports this. No cycle.
 */
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { iamResourceGrants } from '@kortix/db';
import { db } from '../shared/db';
import type { ObjectType as ObjectGrantType } from './catalog';
import { assignRole, SYSTEM_ACTOR } from './assignments';
import { ttlMemo } from '../shared/ttl-memo';
import {
  invalidateIamCacheForProjectResources,
  registerProjectScopedMemo,
} from './cache-invalidation';

/** The resource kinds that support per-resource scoping today. `skill` and
 *  `secret` are READ/REVOKE-only back-compat holdovers — see the module
 *  doc comment above and CREATABLE_RESOURCE_GRANT_TYPES below. agent/skill ids
 *  come from the git config; secret ids are the secret NAME (uppercased key)
 *  from the project_secrets table. */
export const RESOURCE_GRANT_TYPES = ['agent', 'skill', 'secret'] as const;
export type ResourceType = (typeof RESOURCE_GRANT_TYPES)[number];

/** The resource kinds a NEW member/department-scoped grant may be created
 *  for. Only `agent` — skills and secrets are governed by the manager role
 *  (edit) + agent inheritance (use), not a direct member-scoped grant. Existing
 *  skill/secret grant rows (created before this restriction) still read,
 *  list, and revoke normally; this only gates the CREATE path. */
export const CREATABLE_RESOURCE_GRANT_TYPES = ['agent'] as const;
export type CreatableResourceType = (typeof CREATABLE_RESOURCE_GRANT_TYPES)[number];
export function isCreatableResourceType(v: string): v is CreatableResourceType {
  return (CREATABLE_RESOURCE_GRANT_TYPES as readonly string[]).includes(v);
}
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
 * THE per-resource policy for a human caller — the one place that decides what
 * "nobody scoped this" means. Both folds (authorizeV2's single-resource check
 * and filterAccessibleProjectResources' batch filter) route through here, so
 * "can this user use agent X" answers the same whether it is asked one resource
 * at a time or for a whole list.
 *
 * Two independent questions, and only the FIRST one differs by tier:
 *
 *   1. UNSCOPED (no grant rows at all). For an `agent`, open to manager-tier
 *      and CLOSED to member-tier. `skill`/`secret` stay open to everyone.
 *   2. SCOPED (>=1 grant row). Usable only by the named members/groups —
 *      IDENTICALLY for both tiers.
 *
 * Agents turned deny-by-default for members because an unscoped agent is the
 * NORMAL state: projects ship with a `default_agent` and no grants at all.
 * Under the old open rule every member could run every agent in every project
 * they could see, and "grant this department one agent" added nothing, because
 * they already had all of them. The open default made the grants UI decorative
 * for the one case it exists to serve.
 *
 * `managerTier` deliberately moves ONLY the default. A manager is not exempt
 * from an explicit grant: scoping an agent to the finance group still keeps
 * every other manager out of it, which is what makes scoping meaningful at all.
 * What the tier prevents is the opposite failure — a project manager who has
 * created no grants yet being locked out of the agents they administer.
 *
 * Account owners/admins never reach here; they bypass the fold at the call
 * sites, as do service accounts (governed by their own policies + agentGrant).
 */
export function isProjectResourceUsableByMember(
  resourceType: ResourceType,
  grantsForResource: ResourceGrantPrincipal[] | undefined,
  userId: string,
  groupIds: readonly string[],
  managerTier: boolean,
): boolean {
  if (resourceType !== 'agent') {
    return isResourceAccessible(grantsForResource, userId, groupIds);
  }
  // Unscoped agent: the tier decides. Scoped agent: only the grantees, whatever
  // the tier — `isResourceExplicitlyGranted` answers both because it returns
  // false for the empty case, which the branch above has already handled.
  if (!grantsForResource || grantsForResource.length === 0) return managerTier;
  return isResourceExplicitlyGranted(grantsForResource, userId, groupIds);
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
  managerTier = false,
): Promise<string[]> {
  const map = await loadProjectResourceGrants(projectId, resourceType);
  return resourceIds.filter((id) =>
    isProjectResourceUsableByMember(resourceType, map.get(id), userId, groupIds, managerTier),
  );
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
  // …and the canonical object assignment, through the ONE write path, so the
  // grant carries an `iam.assignment.granted` audit event. The route already
  // asserted `project.members.manage`; `SYSTEM_ACTOR` says the caller was
  // authorized THERE rather than re-deriving a different action here.
  //
  // Best-effort: the mirror trigger on `iam_resource_grants` wrote the same
  // canonical row inside the upsert above, so a failure costs the audit event,
  // not the grant.
  try {
    await assignRole(SYSTEM_ACTOR, input.accountId, {
      principal: {
        type: input.principalType === 'group' ? 'group' : 'user',
        id: input.principalId,
      },
      roleKey: 'agent-user',
      scope: { type: 'project', id: input.projectId },
      object: { type: input.resourceType as ObjectGrantType, id: input.resourceId },
      expiresAt: input.expiresAt ?? null,
      source: 'manual',
    });
  } catch (err) {
    console.warn('[resource-grants] canonical object assignment failed', {
      projectId: input.projectId,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      err: (err as Error)?.message,
    });
  }
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
