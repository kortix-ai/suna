/**
 * Per-OBJECT scoping — the repository for object grants.
 *
 * An object grant scopes a member or a group (a Department) to ONE agent inside
 * a project: "Marketing may use agent `outreach-bot`, nothing else." It is one
 * row in `kortix.role_assignments` with `object_type`/`object_id` set and the
 * system `agent-user` role, which carries no permissions of its own — an object
 * grant NARROWS a verdict, it can never add one.
 *
 * WHAT THIS MODULE IS NOT, ANY MORE
 * Until the cutover it also held a second copy of the object rule
 * (`isResourceAccessible`, `isResourceExplicitlyGranted`,
 * `isProjectResourceUsableByMember`, `CLOSED_BY_DEFAULT_RESOURCE_TYPES`) and its
 * own memo over the legacy `iam_resource_grants` table. Both are gone:
 *   * THE object rule is `objectUsable()` inside `iam/authorize.ts`, driven by
 *     `kortix.object_policies` (agent `closed`, skill/secret/app/trigger `open`)
 *     rather than by a hard-coded Set;
 *   * THE grant map is `loadObjectGrants` in the same module, memoized over
 *     `kortix.role_assignments` with the same "never cache an empty map for a
 *     closed-by-default type" rule.
 * What is left here is storage: create, list, delete, and the two cheap
 * project-wide questions the Slack and file-picker read paths ask.
 *
 * AGENT-ONLY, going forward. `skill` and `secret` stay in RESOURCE_GRANT_TYPES
 * purely for back-compat — pre-existing grant rows of those types must keep
 * reading, listing and revoking correctly. NEW grants of those types are
 * rejected at the API layer (CREATABLE_RESOURCE_GRANT_TYPES + the POST gate in
 * projects/routes/resource-grants.ts); this module stays permissive so it never
 * has to know which caller is enforcing that.
 */
import type { ObjectType as ObjectGrantType } from './catalog';
import { assignRole, listAssignments, revokeAssignment, SYSTEM_ACTOR } from './assignments';
import { loadObjectGrants } from './authorize';
import { objectGrantRows } from './read-models';
import { invalidateIamCacheForProjectResources } from './cache-invalidation';

/** The resource kinds that support per-object scoping today. `skill` and
 *  `secret` are READ/REVOKE-only back-compat holdovers — see the module doc
 *  comment above and CREATABLE_RESOURCE_GRANT_TYPES below. agent/skill ids come
 *  from the git config; secret ids are the secret NAME (uppercased key) from the
 *  project_secrets table. */
export const RESOURCE_GRANT_TYPES = ['agent', 'skill', 'secret', 'subproject'] as const;
export type ResourceType = (typeof RESOURCE_GRANT_TYPES)[number];

/** The resource kinds a NEW member/department-scoped grant may be created for.
 *  `agent` and `subproject` — the two closed-by-default object types. Skills
 *  and secrets are governed by the manager role (edit) + agent inheritance
 *  (use), not a direct member-scoped grant. Existing skill/secret grant rows
 *  still read, list and revoke normally; this only gates the CREATE path. */
export const CREATABLE_RESOURCE_GRANT_TYPES = ['agent', 'subproject'] as const;
export type CreatableResourceType = (typeof CREATABLE_RESOURCE_GRANT_TYPES)[number];
export function isCreatableResourceType(v: string): v is CreatableResourceType {
  return (CREATABLE_RESOURCE_GRANT_TYPES as readonly string[]).includes(v);
}
export function isResourceType(v: string): v is ResourceType {
  return (RESOURCE_GRANT_TYPES as readonly string[]).includes(v);
}

export type PrincipalType = 'member' | 'group';

/**
 * Does this project scope ANY agent or skill? Lets read paths (file routes,
 * pickers) skip the whole denied-path computation — and the config load it
 * needs — in the common case where nothing is scoped. Two memo hits, no DB
 * round-trip on the hot path once warm.
 */
export async function hasAnyResourceGrants(projectId: string): Promise<boolean> {
  const [agents, skills, subprojects] = await Promise.all([
    loadObjectGrants(projectId, 'agent'),
    loadObjectGrants(projectId, 'skill'),
    loadObjectGrants(projectId, 'subproject'),
  ]);
  return agents.size > 0 || skills.size > 0 || subprojects.size > 0;
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
  const map = await loadObjectGrants(projectId, resourceType);
  return resourceIds.filter((id) => !map.has(id));
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

/**
 * Every grant for a project (for the Members UI). `grant_id` is the ASSIGNMENT
 * id — the same id `upsertResourceGrant` returns and `deleteResourceGrant`
 * takes.
 */
export async function listResourceGrants(projectId: string): Promise<ResourceGrantRow[]> {
  const rows = await objectGrantRows({ projectId });
  return rows.map((r) => ({
    grantId: r.grantId,
    resourceType: r.resourceType,
    resourceId: r.resourceId,
    principalType: r.principalType,
    principalId: r.principalId,
    expiresAt: r.expiresAt,
    grantedBy: r.grantedBy,
    createdAt: r.createdAt,
  }));
}

/**
 * Create or update a grant. Idempotent on the assignment identity
 * (principal, role, scope, object), so re-granting updates the expiry instead of
 * creating a duplicate.
 *
 * `SYSTEM_ACTOR`: the route already asserted `project.members.manage` before
 * calling. Re-deriving the grant-side action here would ask for it again under a
 * different name. `grantedBy` still records the human.
 */
export async function upsertResourceGrant(input: {
  accountId: string;
  projectId: string;
  resourceType: ResourceType;
  resourceId: string;
  principalType: PrincipalType;
  principalId: string;
  grantedBy: string;
  /** null = no expiry; Date = set. `undefined` is treated as null: an object
   *  grant has no "leave the expiry alone" caller. */
  expiresAt?: Date | null | undefined;
}): Promise<{ grantId: string }> {
  const assignment = await assignRole(SYSTEM_ACTOR, input.accountId, {
    principal: {
      type: input.principalType === 'group' ? 'group' : 'user',
      id: input.principalId,
    },
    roleKey: 'agent-user',
    scope: { type: 'project', id: input.projectId },
    object: { type: input.resourceType as ObjectGrantType, id: input.resourceId },
    expiresAt: input.expiresAt ?? null,
    source: 'manual',
    grantedBy: input.grantedBy,
  });
  invalidateIamCacheForProjectResources(input.projectId);
  return { grantId: assignment.assignmentId };
}

/**
 * Delete a grant by id, scoped to the project so a stray id cannot cross over.
 *
 * The route asserted `project.members.manage` before calling, so
 * `skipWriterAuthz` carries that through instead of re-deriving a different
 * action. Returns false when the id names no object assignment in this project —
 * which is also what a genuinely pre-cutover `iam_resource_grants.grant_id`
 * now does, because that id space no longer exists.
 */
export async function deleteResourceGrant(
  grantId: string,
  projectId: string,
  accountId: string,
): Promise<boolean> {
  const [assignment] = (
    await listAssignments({
      accountId,
      scopeType: 'project',
      scopeId: projectId,
      liveOnly: false,
    })
  ).filter((r) => r.assignmentId === grantId && r.objectType !== null);
  if (!assignment) return false;
  await revokeAssignment(SYSTEM_ACTOR, accountId, grantId, { skipWriterAuthz: true });
  invalidateIamCacheForProjectResources(projectId);
  return true;
}
