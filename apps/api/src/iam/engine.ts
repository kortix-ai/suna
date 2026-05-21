// IAM authorization engine.
//
// `authorize(userId, accountId, action, target?)` is the single chokepoint for
// permission checks. It collects every policy that applies to the user
// (direct + via groups) plus the legacy account_members.account_role bridge,
// matches them against the request's target, and unions the granted actions.
//
// Designed to be called once per (user, accountId) within a request and
// memoised behind a per-request cache (see authorizer.ts). The raw lookup is
// also fast enough to call ad-hoc: one composite SELECT.

import { and, eq, inArray, or } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import {
  accountGroupMembers,
  accountGroups,
  accountMembers,
  iamPolicies,
  iamRolePermissions,
  iamRoles,
} from '@kortix/db';
import { db } from '../shared/db';
import { resourceTypeForAction, type ResourceType } from './actions';

export type AuthorizeTarget =
  | { type: 'account'; id?: never }
  | { type: 'project'; id: string }
  | { type: 'sandbox'; id: string }
  | { type: 'trigger'; id: string }
  | { type: 'channel'; id: string }
  | { type: 'member'; id: string }
  | { type: 'group'; id: string };

export type AuthorizeResult = {
  allowed: boolean;
  reason?: string;
};

type LoadedPolicy = {
  scopeType: ResourceType;
  scopeId: string | null;
  effect: 'allow' | 'deny';
};

type ResolvedActor = {
  isSuperAdmin: boolean;
  groupIds: string[];
};

/**
 * Resolve the actor's membership state in this account: super-admin flag and
 * group memberships. Returns null if the user is not a member. One round-trip.
 */
async function resolveActor(userId: string, accountId: string): Promise<ResolvedActor | null> {
  const [member] = await db
    .select({
      isSuperAdmin: accountMembers.isSuperAdmin,
    })
    .from(accountMembers)
    .where(and(eq(accountMembers.userId, userId), eq(accountMembers.accountId, accountId)))
    .limit(1);

  if (!member) return null;

  const groups = await db
    .select({ groupId: accountGroupMembers.groupId })
    .from(accountGroupMembers)
    .innerJoin(accountGroups, eq(accountGroups.groupId, accountGroupMembers.groupId))
    .where(
      and(
        eq(accountGroupMembers.userId, userId),
        eq(accountGroups.accountId, accountId),
      ),
    );

  return {
    isSuperAdmin: member.isSuperAdmin,
    groupIds: groups.map((g) => g.groupId),
  };
}

/**
 * Load every policy that applies to the actor for the requested action,
 * already filtered to policies whose role grants `action` and whose scope
 * could match the target resource type.
 *
 * Returns the list of (scopeType, scopeId) pairs — the caller decides whether
 * the target's id matches.
 */
async function loadGrantingPolicies(
  accountId: string,
  actor: ResolvedActor,
  userId: string,
  action: string,
  requiredScopeType: ResourceType,
): Promise<LoadedPolicy[]> {
  // Principal filter: this user directly, OR any group they belong to.
  const principalConditions = [
    and(
      eq(iamPolicies.principalType, 'member'),
      eq(iamPolicies.principalId, userId),
    ),
  ];
  if (actor.groupIds.length > 0) {
    principalConditions.push(
      and(
        eq(iamPolicies.principalType, 'group'),
        inArray(iamPolicies.principalId, actor.groupIds),
      ),
    );
  }

  const rows = await db
    .select({
      scopeType: iamPolicies.scopeType,
      scopeId: iamPolicies.scopeId,
      effect: iamPolicies.effect,
    })
    .from(iamPolicies)
    .innerJoin(iamRoles, eq(iamRoles.roleId, iamPolicies.roleId))
    .innerJoin(
      iamRolePermissions,
      and(
        eq(iamRolePermissions.roleId, iamRoles.roleId),
        eq(iamRolePermissions.action, action),
      ),
    )
    .where(
      and(
        eq(iamPolicies.accountId, accountId),
        or(...principalConditions),
        // Scope must be 'account' (Everything) or match the required type.
        or(
          eq(iamPolicies.scopeType, 'account'),
          eq(iamPolicies.scopeType, requiredScopeType),
        ),
      ),
    );

  return rows.map((r) => ({
    scopeType: r.scopeType as ResourceType,
    scopeId: r.scopeId,
    effect: r.effect as 'allow' | 'deny',
  }));
}

/**
 * Core authorization check. Returns Allow/Deny with a brief reason for
 * logging.
 */
export async function authorize(
  userId: string,
  accountId: string,
  action: string,
  target?: AuthorizeTarget,
): Promise<AuthorizeResult> {
  const actor = await resolveActor(userId, accountId);
  if (!actor) {
    return { allowed: false, reason: 'not_a_member' };
  }

  // 1. Super-admin bypasses everything.
  if (actor.isSuperAdmin) {
    return { allowed: true, reason: 'super_admin' };
  }

  const requiredScopeType = resourceTypeForAction(action);
  const effectiveTarget: AuthorizeTarget = target ?? { type: 'account' };

  // Sanity: if the action expects a specific resource and we got an
  // account-level target, only an account-Everything policy can satisfy it.
  // That's fine — the SQL filter handles it. No early-out needed.

  // 2. Explicit policies (direct + via groups). Partition by effect; deny
  //    wins over allow on a per-action+scope basis.
  const policies = await loadGrantingPolicies(
    accountId,
    actor,
    userId,
    action,
    requiredScopeType,
  );

  let matchedAllow = false;
  for (const p of policies) {
    if (!policyMatchesTarget(p, requiredScopeType, effectiveTarget)) continue;
    if (p.effect === 'deny') {
      // Explicit deny is final. Short-circuit immediately so a single deny
      // overrides any number of allows on the same action+scope.
      return { allowed: false, reason: 'explicit_deny' };
    }
    matchedAllow = true;
  }

  if (matchedAllow) {
    return { allowed: true, reason: 'policy' };
  }

  return { allowed: false, reason: 'no_matching_policy' };
}

/**
 * Does a policy's (scopeType, scopeId) cover the request's target?
 *
 *   - scope_type='account' → always matches (Everything)
 *   - scope_type=requiredType AND scope_id=NULL → matches every resource of that type
 *   - scope_type=requiredType AND scope_id=target.id → exact match
 *
 * Exported for unit tests.
 */
export function policyMatchesTarget(
  policy: LoadedPolicy,
  requiredScopeType: ResourceType,
  target: AuthorizeTarget,
): boolean {
  if (policy.scopeType === 'account') return true;
  if (policy.scopeType !== requiredScopeType) return false;
  // For account-level actions targeting the account itself, the only valid
  // policy scope is 'account' (handled above).
  if (target.type === 'account') return false;
  if (policy.scopeId === null) return true; // "all resources of this type"
  return policy.scopeId === target.id;
}

/**
 * Thin assertion wrapper for route handlers. Throws a 403-friendly error if
 * the action is denied.
 */
export async function assertAuthorized(
  userId: string,
  accountId: string,
  action: string,
  target?: AuthorizeTarget,
): Promise<void> {
  const result = await authorize(userId, accountId, action, target);
  if (!result.allowed) {
    // HTTPException (not a plain Error) so Hono's onError maps it to 403
    // instead of falling through to a 500.
    throw new HTTPException(403, {
      message: `forbidden: ${action} (${result.reason ?? 'denied'})`,
    });
  }
}

/**
 * Returns which resource IDs (of `resourceType`) the user can perform
 * `action` on. Used by list endpoints to filter a candidate set without
 * N×authorize() round-trips.
 *
 *   all          – include every candidate
 *   none         – include nothing
 *   allow_only   – include only those whose id is in `allowed`
 *   all_except   – include every candidate except those in `denied`
 *
 * Reads (in the worst case): actor + policies + project_members. That's
 * three queries regardless of how many candidates the caller has.
 */
export type AccessibleResources =
  | { mode: 'all' }
  | { mode: 'none' }
  | { mode: 'allow_only'; allowed: Set<string> }
  | { mode: 'all_except'; denied: Set<string> };

export async function listAccessibleResources(
  userId: string,
  accountId: string,
  action: string,
  resourceType: ResourceType,
): Promise<AccessibleResources> {
  const actor = await resolveActor(userId, accountId);
  if (!actor) return { mode: 'none' };

  if (actor.isSuperAdmin) return { mode: 'all' };

  // Single query: every policy attached to this user (direct or via group)
  // whose role grants `action` and whose scope matches Everything or this
  // resource type. Partitioned by effect in-memory.
  const principalConditions = [
    and(
      eq(iamPolicies.principalType, 'member'),
      eq(iamPolicies.principalId, userId),
    ),
  ];
  if (actor.groupIds.length > 0) {
    principalConditions.push(
      and(
        eq(iamPolicies.principalType, 'group'),
        inArray(iamPolicies.principalId, actor.groupIds),
      ),
    );
  }

  const rows = await db
    .select({
      scopeType: iamPolicies.scopeType,
      scopeId: iamPolicies.scopeId,
      effect: iamPolicies.effect,
    })
    .from(iamPolicies)
    .innerJoin(iamRoles, eq(iamRoles.roleId, iamPolicies.roleId))
    .innerJoin(
      iamRolePermissions,
      and(
        eq(iamRolePermissions.roleId, iamRoles.roleId),
        eq(iamRolePermissions.action, action),
      ),
    )
    .where(
      and(
        eq(iamPolicies.accountId, accountId),
        or(...principalConditions),
        or(eq(iamPolicies.scopeType, 'account'), eq(iamPolicies.scopeType, resourceType)),
      ),
    );

  let allowEverything = false;
  let denyEverything = false;
  const allowedIds = new Set<string>();
  const deniedIds = new Set<string>();

  for (const r of rows) {
    const matchesEverything =
      r.scopeType === 'account' || (r.scopeType === resourceType && r.scopeId === null);
    if (r.effect === 'deny') {
      if (matchesEverything) denyEverything = true;
      else if (r.scopeId) deniedIds.add(r.scopeId);
    } else {
      if (matchesEverything) allowEverything = true;
      else if (r.scopeId) allowedIds.add(r.scopeId);
    }
  }

  // Decide the mode. Deny-everything wins; otherwise allow-everything just
  // shaves off the specific denies; otherwise we have an explicit allow list.
  if (denyEverything) return { mode: 'none' };
  if (allowEverything) return { mode: 'all_except', denied: deniedIds };
  // Strip any allowed entries that also have a per-id deny.
  for (const denied of deniedIds) allowedIds.delete(denied);
  return { mode: 'allow_only', allowed: allowedIds };
}
