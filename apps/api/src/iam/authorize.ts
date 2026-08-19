/**
 * THE canonical authorization engine. One function, one fixed precedence, ten
 * steps, reading only the canonical stores.
 *
 * REPLACES `iam/engine-v2.ts` (authorizeV2, resolveActorV2, loadProjectRoleRows,
 * deriveEffectiveProjectRole, customPolicyAllows, computeTokenScope,
 * agentGrantGates, listAccessibleProjectsV2, filterAccessibleProjectResources),
 * `projects/access.ts` (effectiveProjectRole, roleAllows,
 * foldEffectiveProjectAccess) and `iam/resource-grants.ts`'s fold
 * (isProjectResourceUsableByMember, isResourceAccessible, …) — four independent
 * copies of the max-role fold and three parallel permission vocabularies.
 *
 * WHAT IT READS
 *   kortix.role_assignments  every grant: membership, project roles, group
 *                            grants, custom-role bindings, object grants
 *   kortix.iam_roles         (canonical name: kortix.roles) system + custom roles
 *   kortix.iam_role_actions  (canonical name: kortix.role_permissions)
 *   kortix.permissions       the action catalog + its scope classifier
 *   kortix.object_policies   the unscoped-object default, per object type
 *
 * WHAT IT ALSO READS, AND WHY THAT IS NOT A LEGACY DEPENDENCY
 *   account_members.is_super_admin  a hard, audited bypass, deliberately NOT a
 *     role (spec §1). 22,408 of 33,363 local membership rows carry it, so
 *     turning it into an assignment would start evaluating folds that have been
 *     dead for two thirds of principals.
 *   accounts.mfa_required           an account setting, not a permission.
 *   account_group_members           (canonical name: kortix.group_members) —
 *     group MEMBERSHIP, which is an identity fact, not a grant.
 *   service_accounts                the principal must exist and be active.
 * It reads NONE of project_members, project_group_grants, iam_policies,
 * iam_resource_grants or account_members.account_role.
 */
import { and, eq, gt, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import {
  accountGroupMembers,
  accountMembers,
  accounts,
  iamRoleActions,
  iamRoles,
  roleAssignments,
  serviceAccounts,
} from '@kortix/db';
import { db } from '../shared/db';
import { retryTransientDatabaseRead } from '../shared/database-errors';
import { isImpersonatingAccount, isImpersonationBlockedAccount } from '../shared/impersonation';
import { ttlMemo } from '../shared/ttl-memo';
import { agentMayPerform } from './agent-scope';
import {
  loadPermissionCatalog,
  loadSystemRoles,
  scopeForUncatalogedAction,
  unscopedDefaultFor,
  type ObjectType,
  type ScopeType,
} from './catalog';
import { registerPrincipalScopedMemo, registerProjectScopedMemo } from './cache-invalidation';
import { buildDenialError } from './denial-message';
import {
  actingPrincipal,
  actingTokenId,
  loadTokenBinding,
  type Actor,
  type PrincipalRef,
} from './actor';

// ─── Public surface ─────────────────────────────────────────────────────────

/** The object a verdict is about. */
export type Obj =
  | { type: 'account' }
  | { type: 'project'; id: string; resource?: { type: ObjectType; id: string } };

/**
 * Why. Denial reasons are byte-identical to the strings `denial-message.ts` is
 * keyed on, because the 403 wording depends on them. The three ALLOW reasons
 * collapse to one (`role`) per spec §2.2: `account_role`, `project_role` and
 * `custom_policy` all mean "a role the principal holds grants this action", and
 * nothing renders them — the distinction only ever leaked the storage shape.
 */
export type Reason =
  | 'impersonation'
  | 'impersonation_scope'
  | 'token_out_of_scope'
  | 'not_a_member'
  | 'super_admin'
  | 'account_mfa_required'
  | 'role'
  | 'account_role_insufficient'
  | 'project_target_required'
  | 'no_project_membership'
  | 'project_role_insufficient'
  | 'service_account_scope_insufficient'
  | 'resource_scope_insufficient'
  | 'agent_scope_insufficient';

export interface Verdict {
  allowed: boolean;
  reason: Reason;
}

/** Which objects of a type the actor may act on. */
export type Accessible =
  | { mode: 'all' }
  | { mode: 'none' }
  | { mode: 'allow_only'; allowed: Set<string> };

const allow = (reason: Reason): Verdict => ({ allowed: true, reason });
const deny = (reason: Reason): Verdict => ({ allowed: false, reason });

/**
 * The coarse project actions `loadProjectForUser` maps onto. An agent session's
 * kortix.yaml grant must NOT gate them: a route doing
 * `loadProjectForUser('write')` is asking a membership-tier question, and a
 * leaf-scoped agent (e.g. kortixCli=['project.gitops.push']) still has to pass
 * it — the route's own leaf assertion is what the grant gates. Every OTHER
 * project action is a specific capability the agent must hold.
 */
const AGENT_GRANT_EXEMPT_ACTIONS: ReadonlySet<string> = new Set([
  'project.read',
  'project.write',
]);

/**
 * Authorize `actor` to perform `action` on `obj`.
 *
 * Precedence is fixed and total — every branch below returns, so there is no
 * order in which two rules can both apply:
 *
 *   1  impersonation act-as, then impersonation confinement
 *   2  the acting token's binding
 *   3  the acting principal (activated agent SA, else the launcher)
 *   4  token project scope
 *   5  super-admin bypass
 *   6  account-MFA gate (browser sessions only)
 *   7  scope containment + role expansion
 *   8  the verdict, and which constraint denied it
 *   9  object grants
 *  10  the agent-session grant intersection
 */
export async function authorize(actor: Actor, action: string, obj: Obj = { type: 'account' }): Promise<Verdict> {
  // 1. ACT-AS. Above everything, and above the principal memo in particular:
  // `resolvePrincipal` is a TTL memo shared across requests, so widening the
  // actor inside it would cache "owner" and serve it to this operator's own
  // NON-impersonated requests for the rest of the window. Short-circuiting here
  // touches no cache at all. The grant was already validated this request by
  // middleware/impersonation.ts.
  if (isImpersonatingAccount(actor.userId, actor.accountId)) return allow('impersonation');
  // Confinement, not just widening: while a grant is live the operator is
  // denied every OTHER account, their own included.
  if (isImpersonationBlockedAccount(actor.userId, actor.accountId)) return deny('impersonation_scope');

  const catalog = await loadPermissionCatalog();
  const entry = catalog.byAction.get(action);
  const scope: ScopeType = entry?.scopeType ?? scopeForUncatalogedAction(action);

  // 2. The acting token's binding: project confinement, agent grant, standing
  // identity — one memoized read, skipped entirely for browser requests.
  const tokenId = actingTokenId(actor);
  const binding = tokenId ? await loadTokenBinding(tokenId) : null;

  // 3. The acting principal.
  const principal = actingPrincipal(actor);
  const rec = await resolvePrincipal(principal, actor.accountId);
  if (!rec) return deny('not_a_member');

  // 4. A token bound to one project is refused on every other project and on
  // every account-level action.
  if (!tokenScopeAllows(binding, tokenId, rec.kind, scope, obj)) return deny('token_out_of_scope');

  // 5. Super-admin. Above the MFA gate on purpose: flipping account MFA must
  // never be able to lock an account out permanently.
  if (rec.isSuperAdmin) return allow('super_admin');

  // 6. Account-wide MFA. Browser sessions only — a token's scope was just
  // verified in step 4, and a PAT has no second factor to step up with.
  if (rec.accountMfaRequired && !tokenId && actor.ctx.mfaAal !== 'aal2') {
    return deny('account_mfa_required');
  }

  // 7/8. Account scope.
  if (scope === 'account') {
    if (rec.kind === 'member' && rec.accountRoleActions.has(action)) return allow('role');
    if (customRoleAllows(rec, scope, action, obj)) return allow('role');
    return deny('account_role_insufficient');
  }

  if (obj.type !== 'project') return deny('project_target_required');

  // A custom role can grant project access with NO system project role at all
  // (the department case), so the system role is one source in the union, not a
  // gate. A service account has no membership and therefore no system project
  // role — its project access comes only from its own assignments.
  const roles = await loadSystemRoles();
  const systemRole = rec.kind === 'member' ? effectiveProjectRole(roles, rec, obj.id) : null;
  const granted =
    (systemRole !== null && systemRole.actions.has(action)) || customRoleAllows(rec, scope, action, obj);

  if (!granted) {
    if (rec.kind === 'service_account') return deny('service_account_scope_insufficient');
    if (systemRole === null) return deny('no_project_membership');
    return deny('project_role_insufficient');
  }

  // 9. OBJECT GRANTS. Only for a human member below the implicit-manager tier:
  // account owners/admins and service accounts bypass, exactly as today.
  //
  // A project `manager` does NOT bypass — an explicit grant restricts them as
  // much as it restricts a member, which is what makes "scope this agent to the
  // finance group" mean anything. What the manager tier buys is the UNSCOPED
  // default, and that default is now a property of the OBJECT TYPE
  // (object_policies) rather than an argument threaded through the caller.
  if (obj.resource && rec.kind === 'member' && !isImplicitManager(rec.accountRoleKey)) {
    const managerTier = systemRole !== null && systemRole.actions.has('project.write');
    const grants = await loadObjectGrants(obj.id, obj.resource.type);
    const usable = await objectUsable(
      obj.resource.type,
      grants.get(obj.resource.id),
      principal.id,
      rec.groupIds,
      managerTier,
    );
    if (!usable) return deny('resource_scope_insufficient');
  }

  // 10. role ∩ agent grant. Enforced HERE, centrally, so a new route cannot
  // forget it — the 23 per-route `assertAgentScope` calls are the duplicate.
  // No-op for non-agent tokens (null grant) and for `kortixCli: all`.
  if (tokenId && !AGENT_GRANT_EXEMPT_ACTIONS.has(action)) {
    if (!agentMayPerform(binding?.agentGrant ?? null, action)) {
      return deny('agent_scope_insufficient');
    }
  }

  return allow('role');
}

/** `authorize`, but a denial throws the 403 the route layer surfaces. */
export async function assertAuthorized(actor: Actor, action: string, obj: Obj = { type: 'account' }): Promise<void> {
  const verdict = await authorize(actor, action, obj);
  if (!verdict.allowed) throw buildDenialError(action, verdict.reason);
}

/**
 * Batch sibling: which resources of `resourceType` may the actor perform
 * `action` on. Kept because a per-item loop would be an N+1 on the hottest
 * pages — `GET /v1/projects` and the agent/skill lists.
 *
 * Returns the accessible PROJECT ids. Every other resource type is reached
 * through its project and answered by `filterAccessibleObjects`, which takes
 * the ids the manifest declares — see the note in the body.
 */
export async function listAccessible(
  actor: Actor,
  action: string,
  resourceType: 'project' | ObjectType,
): Promise<Accessible> {
  // Only projects are listable standalone. An object (an agent, a skill) is
  // always reached THROUGH its project, and the caller already holds the ids
  // the manifest declares — `filterAccessibleObjects` is that surface, and it
  // can answer the unscoped-default question the id-less `Accessible` shape
  // cannot express.
  if (resourceType !== 'project') return { mode: 'none' };
  return listAccessibleProjects(actor, action);
}

async function listAccessibleProjects(actor: Actor, action: string): Promise<Accessible> {
  // Same short-circuit as authorize, for the same cache reason. Without it the
  // operator sees an empty project list inside an account whose every project
  // they can already open by id — a confusing half-state, not a narrower one.
  if (isImpersonatingAccount(actor.userId, actor.accountId)) return { mode: 'all' };
  if (isImpersonationBlockedAccount(actor.userId, actor.accountId)) return { mode: 'none' };

  const tokenId = actingTokenId(actor);
  const binding = tokenId ? await loadTokenBinding(tokenId) : null;
  const principal = actingPrincipal(actor);
  const rec = await resolvePrincipal(principal, actor.accountId);
  if (!rec) return { mode: 'none' };

  // A token bound to one project narrows the listing to that project, for a
  // human PAT and an agent session alike. A direct service-account bearer has
  // no account_tokens row, so its own assignments drive the listing below; a
  // null binding for anything else is a revoked token.
  if (tokenId) {
    if (!binding) {
      if (rec.kind !== 'service_account') return { mode: 'none' };
    } else if (binding.projectId) {
      const v = await authorize(actor, action, { type: 'project', id: binding.projectId });
      return v.allowed ? { mode: 'allow_only', allowed: new Set([binding.projectId]) } : { mode: 'none' };
    }
  }

  if (rec.isSuperAdmin) return { mode: 'all' };
  if (rec.accountMfaRequired && !tokenId && actor.ctx.mfaAal !== 'aal2') return { mode: 'none' };

  const roles = await loadSystemRoles();

  // Owner/admin hold implicit Manager on every project: allowed unless Manager
  // itself lacks the action.
  if (isImplicitManager(rec.accountRoleKey)) {
    const manager = roles.byKey.get('project:manager');
    return manager?.actions.has(action) ? { mode: 'all' } : { mode: 'none' };
  }

  const allowed = new Set<string>();
  for (const [projectId, roleIds] of rec.projectSystemRoleIds) {
    for (const roleId of roleIds) {
      if (roles.byId.get(roleId)?.actions.has(action)) {
        allowed.add(projectId);
        break;
      }
    }
  }
  // Custom roles union in: an account-scoped one covers every project, a
  // project-scoped one adds just its project — so a department member sees the
  // company project with no system project role at all.
  for (const ca of rec.customActions) {
    if (ca.action !== action) continue;
    if (ca.scopeType === 'account') return { mode: 'all' };
    if (ca.scopeType === 'project' && ca.scopeId) allowed.add(ca.scopeId);
  }
  return { mode: 'allow_only', allowed };
}

/**
 * Of `objectIds`, the ones the actor may use. The list form of step 9 — used by
 * the agent/skill pickers, which must not render an object the caller cannot
 * launch. Preserves input order, one memo hit for the whole list.
 */
export async function filterAccessibleObjects(
  actor: Actor,
  projectId: string,
  objectType: ObjectType,
  objectIds: readonly string[],
): Promise<string[]> {
  if (objectIds.length === 0) return [];
  const principal = actingPrincipal(actor);
  const rec = await resolvePrincipal(principal, actor.accountId);
  if (!rec) return [];
  if (rec.isSuperAdmin) return [...objectIds];
  if (rec.kind !== 'member') return [...objectIds];
  if (isImplicitManager(rec.accountRoleKey)) return [...objectIds];

  const roles = await loadSystemRoles();
  const systemRole = effectiveProjectRole(roles, rec, projectId);
  const managerTier = systemRole !== null && systemRole.actions.has('project.write');
  const grants = await loadObjectGrants(projectId, objectType);
  const unscopedOpen = (await unscopedDefaultFor(objectType)) === 'open';

  const groups = new Set(rec.groupIds);
  return objectIds.filter((id) => {
    const principals = grants.get(id);
    if (!principals || principals.length === 0) return unscopedOpen || managerTier;
    return principals.some(
      (p) =>
        (p.principalType === 'user' && p.principalId === principal.id) ||
        (p.principalType === 'group' && groups.has(p.principalId)),
    );
  });
}

// ─── Pure decision helpers (exported for unit tests) ────────────────────────

/**
 * Is the acting token in scope for this request? Computed from the binding
 * already loaded — no extra query.
 *
 *   no token                 -> true  (browser)
 *   null binding             -> true only for a direct service-account bearer,
 *                               which has no account_tokens row at all; a null
 *                               binding for anything else is a revoked token
 *   unscoped token           -> true, falls through to permissions
 *   account-level action     -> false, a project-bound token has no account reach
 *   any other project        -> false
 */
export function tokenScopeAllows(
  binding: { projectId: string | null } | null,
  tokenId: string | undefined,
  principalKind: 'member' | 'service_account',
  scope: ScopeType,
  obj: Obj,
): boolean {
  if (!tokenId) return true;
  if (!binding) return principalKind === 'service_account';
  if (!binding.projectId) return true;
  if (scope === 'account') return false;
  if (obj.type !== 'project') return false;
  return obj.id === binding.projectId;
}

/** Owner and admin hold implicit Manager on every project in their account. */
export function isImplicitManager(accountRoleKey: string | null): boolean {
  return accountRoleKey === 'owner' || accountRoleKey === 'admin';
}

/**
 * Is this object usable? THE object rule, and the only place that decides what
 * "nobody scoped this" means.
 *
 *   no grant rows at all -> the OBJECT TYPE's default (agents closed, the rest
 *                           open), with the manager tier always getting open
 *   >=1 grant row        -> only the named principals, identically for both
 *                           tiers
 */
export async function objectUsable(
  objectType: string,
  grantsForObject: Array<{ principalType: string; principalId: string }> | undefined,
  principalId: string,
  groupIds: readonly string[],
  managerTier: boolean,
): Promise<boolean> {
  if (!grantsForObject || grantsForObject.length === 0) {
    if (managerTier) return true;
    return (await unscopedDefaultFor(objectType)) === 'open';
  }
  const groups = new Set(groupIds);
  return grantsForObject.some(
    (g) =>
      (g.principalType === 'user' && g.principalId === principalId) ||
      (g.principalType === 'group' && groups.has(g.principalId)),
  );
}

// ─── Principal resolution ───────────────────────────────────────────────────

const TTL_MS = (() => {
  const raw = Number(process.env.IAM_CACHE_TTL_MS);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 15_000;
})();

/** An action a CUSTOM role grants the principal, and where it applies. */
export interface CustomAction {
  scopeType: string;
  scopeId: string | null;
  action: string;
}

interface PrincipalRecord {
  /** 'member' = an account member (has a system role at account scope).
   *  'service_account' = a machine identity with no membership baseline. */
  kind: 'member' | 'service_account';
  isSuperAdmin: boolean;
  accountMfaRequired: boolean;
  /** 'owner' | 'admin' | 'member', from the system role held at account scope. */
  accountRoleKey: string | null;
  accountRoleActions: ReadonlySet<string>;
  groupIds: string[];
  /** projectId -> the SYSTEM project roles held there (direct or via a group). */
  projectSystemRoleIds: ReadonlyMap<string, string[]>;
  /** Actions from NON-system (account-authored) roles. */
  customActions: CustomAction[];
}

/**
 * Everything about the principal that does not depend on the object.
 *
 * FOUR queries, all in ONE `Promise.all` — depth, not count, is what costs time
 * on a page that fires 10+ authorized requests in parallel. That is the same
 * depth `resolveActorV2` had, and it must not grow: `loadProjectForUser` alone
 * runs at 194 call sites.
 *
 * Positive-only caching, deliberately: a freshly granted member sees access on
 * their very next request, while a revoked one keeps it for at most one TTL
 * window. That asymmetry is the existing security posture, and every write path
 * calls `invalidateIamCacheForUser` to close the revoke side on the writing
 * replica.
 */
async function resolvePrincipalUncached(
  principal: PrincipalRef,
  accountId: string,
): Promise<PrincipalRecord | null> {
  if (!accountId) return null;
  const pid = principal.id;

  // Group membership drives two of the four queries, so it is inlined as a
  // subquery rather than awaited first — otherwise the whole resolve becomes
  // two round trips instead of one.
  const memberGroups = db
    .select({ gid: accountGroupMembers.groupId })
    .from(accountGroupMembers)
    .where(eq(accountGroupMembers.userId, pid));

  const principalMatches = or(
    and(eq(roleAssignments.principalType, 'user'), eq(roleAssignments.principalId, pid)),
    and(eq(roleAssignments.principalType, 'group'), inArray(roleAssignments.principalId, memberGroups)),
    and(eq(roleAssignments.principalType, 'service_account'), eq(roleAssignments.principalId, pid)),
  );
  const live = or(isNull(roleAssignments.expiresAt), gt(roleAssignments.expiresAt, sql`now()`));

  const [identityRows, groupRows, assignmentRows, customRows] = await Promise.all([
    // is_super_admin and mfa_required are NOT permissions — see the module note.
    db
      .select({ isSuperAdmin: accountMembers.isSuperAdmin, mfaRequired: accounts.mfaRequired })
      .from(accountMembers)
      .innerJoin(accounts, eq(accounts.accountId, accountMembers.accountId))
      .where(and(eq(accountMembers.userId, pid), eq(accountMembers.accountId, accountId)))
      .limit(1),
    db
      .select({ groupId: accountGroupMembers.groupId })
      .from(accountGroupMembers)
      .where(eq(accountGroupMembers.userId, pid)),
    // Assignments of SYSTEM roles, plus every object assignment. No action join:
    // the six system roles are memoized whole, so expanding them costs nothing.
    retryTransientDatabaseRead(async () =>
      db
        .select({
          roleId: roleAssignments.roleId,
          scopeType: roleAssignments.scopeType,
          scopeId: roleAssignments.scopeId,
          objectType: roleAssignments.objectType,
          roleKey: iamRoles.key,
          roleScopeType: iamRoles.scopeType,
        })
        .from(roleAssignments)
        .innerJoin(iamRoles, eq(iamRoles.roleId, roleAssignments.roleId))
        .where(and(eq(roleAssignments.accountId, accountId), live, isNull(iamRoles.accountId), principalMatches)),
    ),
    // Actions granted by CUSTOM roles. Joined here for the same reason the
    // legacy policy query joined: it keeps the resolve one round trip deep, and
    // it returns [] for the overwhelmingly common account with no custom roles.
    retryTransientDatabaseRead(async () =>
      db
        .select({
          scopeType: roleAssignments.scopeType,
          scopeId: roleAssignments.scopeId,
          action: iamRoleActions.action,
        })
        .from(roleAssignments)
        .innerJoin(iamRoles, eq(iamRoles.roleId, roleAssignments.roleId))
        .innerJoin(iamRoleActions, eq(iamRoleActions.roleId, roleAssignments.roleId))
        .where(
          and(
            eq(roleAssignments.accountId, accountId),
            live,
            isNotNull(iamRoles.accountId),
            isNull(roleAssignments.objectType),
            principalMatches,
          ),
        ),
    ),
  ]);

  const systemRoles = await loadSystemRoles();

  let accountRoleKey: string | null = null;
  let accountRoleActions: ReadonlySet<string> = EMPTY_SET;
  const projectSystemRoleIds = new Map<string, string[]>();

  for (const row of assignmentRows) {
    // An object assignment carries the `agent-user` marker role and grants
    // nothing on its own — it must never be read as a project role, or a member
    // handed one agent would silently acquire the tier the role implies.
    if (row.objectType !== null) continue;
    if (row.roleScopeType === 'account' && row.scopeType === 'account') {
      const role = systemRoles.byId.get(row.roleId);
      if (role && accountRoleRank(role.key) > accountRoleRank(accountRoleKey)) {
        accountRoleKey = role.key;
        accountRoleActions = role.actions;
      }
      continue;
    }
    if (row.roleScopeType === 'project' && row.scopeType === 'project' && row.scopeId) {
      if (row.roleKey === 'agent-user') continue;
      const list = projectSystemRoleIds.get(row.scopeId);
      if (list) list.push(row.roleId);
      else projectSystemRoleIds.set(row.scopeId, [row.roleId]);
    }
  }

  const customActions: CustomAction[] = customRows.map((r) => ({
    scopeType: r.scopeType,
    scopeId: r.scopeId,
    action: r.action,
  }));

  if (accountRoleKey !== null) {
    return {
      kind: 'member',
      isSuperAdmin: identityRows[0]?.isSuperAdmin ?? false,
      accountMfaRequired: identityRows[0]?.mfaRequired ?? false,
      accountRoleKey,
      accountRoleActions,
      groupIds: groupRows.map((g) => g.groupId),
      projectSystemRoleIds,
      customActions,
    };
  }

  // Not a member. Is this id a service account in this account? Rare path: only
  // service-account requests and genuinely unknown ids reach here, so the extra
  // query never touches the hot human/PAT path.
  const [sa] = await db
    .select({ id: serviceAccounts.serviceAccountId })
    .from(serviceAccounts)
    .where(
      and(
        eq(serviceAccounts.serviceAccountId, pid),
        eq(serviceAccounts.accountId, accountId),
        eq(serviceAccounts.status, 'active'),
      ),
    )
    .limit(1);
  if (!sa) return null;

  return {
    kind: 'service_account',
    isSuperAdmin: false,
    accountMfaRequired: false,
    accountRoleKey: null,
    accountRoleActions: EMPTY_SET,
    groupIds: [],
    projectSystemRoleIds,
    customActions,
  };
}

const EMPTY_SET: ReadonlySet<string> = new Set<string>();

const resolvePrincipalMemo = ttlMemo({
  ttlMs: TTL_MS,
  keyFn: (principal: PrincipalRef, accountId: string) => `${principal.id}|${accountId}`,
  loader: resolvePrincipalUncached,
  shouldCache: (rec) => rec !== null,
});
// Key is `${principalId}|…` so invalidateIamCacheForUser busts it, and a service
// account is its own principal id — one contract for both.
registerPrincipalScopedMemo(resolvePrincipalMemo);

export function resolvePrincipal(principal: PrincipalRef, accountId: string): Promise<PrincipalRecord | null> {
  return resolvePrincipalMemo(principal, accountId);
}

function accountRoleRank(key: string | null): number {
  if (key === 'owner') return 3;
  if (key === 'admin') return 2;
  if (key === 'member') return 1;
  return 0;
}

/**
 * The principal's effective SYSTEM role on one project: the strongest of the
 * implicit account role, the direct assignment, and every group assignment.
 * This is the ONE fold — `deriveEffectiveProjectRole`, the inline fold in
 * `listAccessibleProjectsV2`, `foldEffectiveProjectAccess` and the route-local
 * copy in `accounts/iam/members.ts` were four implementations of it.
 */
function effectiveProjectRole(
  roles: SystemRoleIndex,
  rec: PrincipalRecord,
  projectId: string,
): { key: string; actions: ReadonlySet<string> } | null {
  let best: { key: string; actions: ReadonlySet<string> } | null = null;
  if (isImplicitManager(rec.accountRoleKey)) {
    const manager = roles.byKey.get('project:manager');
    if (manager) best = manager;
  }
  for (const roleId of rec.projectSystemRoleIds.get(projectId) ?? []) {
    const role = roles.byId.get(roleId);
    if (!role) continue;
    if (!best || projectRoleRank(role.key) > projectRoleRank(best.key)) best = role;
  }
  return best;
}

type SystemRoleIndex = Awaited<ReturnType<typeof loadSystemRoles>>;

function projectRoleRank(key: string): number {
  return key === 'manager' ? 2 : key === 'member' ? 1 : 0;
}


/**
 * Allow-only union with the system role: an account-scoped custom role grants
 * the action on every project, a project-scoped one only on its own project.
 * There is no deny — a custom role can only ever ADD.
 */
export function customRoleAllows(
  rec: { customActions: CustomAction[] },
  scope: ScopeType,
  action: string,
  obj: Obj,
): boolean {
  if (rec.customActions.length === 0) return false;
  for (const ca of rec.customActions) {
    if (ca.action !== action) continue;
    if (ca.scopeType === 'account') return true;
    if (scope === 'project' && obj.type === 'project' && ca.scopeType === 'project' && ca.scopeId === obj.id) {
      return true;
    }
  }
  return false;
}

// ─── Object grants ──────────────────────────────────────────────────────────

interface ObjectGrantPrincipal {
  principalType: string;
  principalId: string;
}

/**
 * (project, objectType) -> objectId -> the principals granted it.
 *
 * The EMPTY map is cached, unlike every other authz memo. That is deliberate
 * and pre-existing: "this project scopes nothing" is the common, hot case, and
 * every mutation busts the project entry synchronously on the writing replica.
 * The trade is that a grant CREATE can lag one TTL window on a replica that did
 * not perform the write, where a role grant is instant.
 */
const loadObjectGrants = ttlMemo({
  ttlMs: TTL_MS,
  keyFn: (projectId: string, objectType: string) => `${projectId}|${objectType}`,
  loader: async (projectId: string, objectType: string) => {
    const rows = await db
      .select({
        objectId: roleAssignments.objectId,
        principalType: roleAssignments.principalType,
        principalId: roleAssignments.principalId,
      })
      .from(roleAssignments)
      .where(
        and(
          eq(roleAssignments.scopeType, 'project'),
          eq(roleAssignments.scopeId, projectId),
          eq(roleAssignments.objectType, objectType),
          or(isNull(roleAssignments.expiresAt), gt(roleAssignments.expiresAt, sql`now()`)),
        ),
      );
    const map = new Map<string, ObjectGrantPrincipal[]>();
    for (const r of rows) {
      if (!r.objectId) continue;
      const entry = { principalType: r.principalType, principalId: r.principalId };
      const list = map.get(r.objectId);
      if (list) list.push(entry);
      else map.set(r.objectId, [entry]);
    }
    return map;
  },
  shouldCache: () => true,
});
registerProjectScopedMemo(loadObjectGrants);

export { loadObjectGrants };

/** Test hook: drop the principal + object-grant memos. */
export function clearAuthorizeCaches(): void {
  resolvePrincipalMemo.clear();
  loadObjectGrants.clear();
}
