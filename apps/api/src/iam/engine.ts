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

import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  accountGroupMembers,
  accountGroups,
  accountMembers,
  iamPolicies,
  iamRolePermissions,
  iamRoles,
  projectMembers,
} from '@kortix/db';
import { db } from '../shared/db';
import { resourceTypeForAction, type ResourceType } from './actions';
import { SYSTEM_ROLE_KEY } from './system-roles';

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
  accountRole: 'owner' | 'admin' | 'member' | null;
  groupIds: string[];
};

const SYSTEM_ROLE_PERMISSION_CACHE = new Map<string, Set<string>>();

/**
 * Look up the action-set of a system role by key, memoised.
 * Used by the legacy-role bridge to materialise the synthetic policies for
 * existing account_members rows without inserting them.
 */
async function getSystemRoleActions(key: string): Promise<Set<string>> {
  const cached = SYSTEM_ROLE_PERMISSION_CACHE.get(key);
  if (cached) return cached;

  const rows = await db
    .select({ action: iamRolePermissions.action })
    .from(iamRoles)
    .innerJoin(iamRolePermissions, eq(iamRolePermissions.roleId, iamRoles.roleId))
    .where(and(isNull(iamRoles.accountId), eq(iamRoles.key, key)));

  const set = new Set(rows.map((r) => r.action));
  SYSTEM_ROLE_PERMISSION_CACHE.set(key, set);
  return set;
}

/** Bust the system-role permission cache. Called by seedSystemRoles after writes. */
export function invalidateSystemRoleCache(): void {
  SYSTEM_ROLE_PERMISSION_CACHE.clear();
}

/**
 * Resolve the actor's membership state in this account: super-admin flag,
 * legacy account role, and group memberships. One round-trip.
 */
async function resolveActor(userId: string, accountId: string): Promise<ResolvedActor | null> {
  const [member] = await db
    .select({
      isSuperAdmin: accountMembers.isSuperAdmin,
      accountRole: accountMembers.accountRole,
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
    accountRole: member.accountRole as ResolvedActor['accountRole'],
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
 * Legacy account_role bridge. Until every member has explicit policies, we
 * synthesise them from the existing account_members.account_role enum so the
 * engine matches today's behaviour.
 *
 *   owner / admin → Administrator policy at account Everything scope
 *   member        → Administrator Read-Only at account Everything scope
 *
 * Super-admin short-circuits before this is consulted.
 */
async function bridgeLegacyAccountRole(
  actor: ResolvedActor,
  action: string,
): Promise<boolean> {
  if (!actor.accountRole) return false;

  const key =
    actor.accountRole === 'owner' || actor.accountRole === 'admin'
      ? SYSTEM_ROLE_KEY.ADMINISTRATOR
      : SYSTEM_ROLE_KEY.ADMINISTRATOR_READ_ONLY;
  const actions = await getSystemRoleActions(key);
  return actions.has(action);
}

/**
 * Legacy project_members bridge. Pre-existing project access via the
 * project_members table is materialised as a synthetic Project Admin /
 * Editor / Viewer policy scoped to that project.
 */
async function bridgeLegacyProjectRole(
  accountId: string,
  userId: string,
  projectId: string,
  action: string,
): Promise<boolean> {
  const [pm] = await db
    .select({ projectRole: projectMembers.projectRole })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.accountId, accountId),
        eq(projectMembers.userId, userId),
        eq(projectMembers.projectId, projectId),
      ),
    )
    .limit(1);
  if (!pm) return false;

  const key =
    pm.projectRole === 'manager'
      ? SYSTEM_ROLE_KEY.PROJECT_ADMIN
      : pm.projectRole === 'editor'
        ? SYSTEM_ROLE_KEY.PROJECT_EDITOR
        : SYSTEM_ROLE_KEY.PROJECT_VIEWER;
  const actions = await getSystemRoleActions(key);
  return actions.has(action);
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

  // 3. Legacy bridges (only consulted when no explicit policy matched).
  //    Explicit denies above already short-circuited.
  if (await bridgeLegacyAccountRole(actor, action)) {
    return { allowed: true, reason: 'legacy_account_role' };
  }

  if (
    effectiveTarget.type === 'project' &&
    (await bridgeLegacyProjectRole(accountId, userId, effectiveTarget.id, action))
  ) {
    return { allowed: true, reason: 'legacy_project_role' };
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
    const err = new Error(`forbidden: ${action} (${result.reason ?? 'denied'})`);
    (err as Error & { status?: number }).status = 403;
    throw err;
  }
}
