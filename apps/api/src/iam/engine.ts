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
  accounts,
  iamPolicies,
  iamRolePermissions,
  iamRoles,
  projectGroupMembers,
  projectMembers,
} from '@kortix/db';
import { db } from '../shared/db';
import { ipMatchesAny, parseCidr } from '../shared/cidr';
import { ACCOUNT_ACTIONS, resourceTypeForAction, type ResourceType } from './actions';
import { SYSTEM_ROLE_KEY } from './system-roles';
import { recordAllow } from './usage-recorder';

// Account-level read actions the legacy 'member' role keeps via the bridge.
// We intentionally exclude every project.*/sandbox.*/etc. read so a plain
// member doesn't accidentally see every project in the account just because
// the system role they bridge to bundled project.read. Resource access
// comes from explicit IAM policies or project_members rows instead.
const LEGACY_MEMBER_ACCOUNT_READS: ReadonlySet<string> = new Set([
  ACCOUNT_ACTIONS.ACCOUNT_READ,
  ACCOUNT_ACTIONS.MEMBER_READ,
  ACCOUNT_ACTIONS.GROUP_READ,
  ACCOUNT_ACTIONS.POLICY_READ,
  ACCOUNT_ACTIONS.ROLE_READ,
  ACCOUNT_ACTIONS.AUDIT_READ,
  ACCOUNT_ACTIONS.TOKEN_READ,
  ACCOUNT_ACTIONS.BILLING_READ,
]);

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

/** Scope types a policy can target. Superset of ResourceType — the
 *  extras (project_group) aren't real resource categories, they're
 *  containers the engine resolves at match time. */
export type PolicyScopeType = ResourceType | 'project_group';

type LoadedPolicy = {
  scopeType: PolicyScopeType;
  scopeId: string | null;
  effect: 'allow' | 'deny';
  conditions: PolicyConditions;
};

/**
 * Optional checks evaluated after scope+role match. The engine treats an
 * empty object as "no conditions, always passes". Multiple conditions
 * compose with AND semantics — every configured check must pass.
 */
export interface PolicyConditions {
  /** Request IP must fall in one of these CIDRs (IPv4 or IPv6). Empty
   *  array = no restriction; condition isn't considered "configured". */
  ip_cidrs?: string[];
  /** Session must be at AAL2 (MFA step-up). Tracks Supabase's
   *  Authenticator Assurance Level. */
  require_mfa?: boolean;
}

/**
 * Per-request context surfaced from middleware: caller IP, MFA AAL,
 * acting token. Optional everywhere — when a policy has no conditions
 * the engine never reads these fields, so existing call sites that
 * pre-date conditions keep working unchanged.
 */
export interface RequestContext {
  /** Caller's source IP, taken from x-forwarded-for or x-real-ip. */
  ip?: string;
  /** JWT's aal claim — 'aal1' = password-only, 'aal2' = MFA-verified. */
  mfaAal?: string;
}

type ResolvedActor = {
  isSuperAdmin: boolean;
  accountRole: 'owner' | 'admin' | 'member' | null;
  groupIds: string[];
  /** When true the engine refuses to fall back to legacy bridges — only
   * super-admin bypass + explicit policies decide. Account-wide setting. */
  iamStrictMode: boolean;
  /** When true the engine denies every JWT request whose aal claim is
   * not 'aal2'. Super-admins are exempt; PATs are exempt (they gate
   * via per-policy require_mfa conditions). Account-wide setting. */
  accountMfaRequired: boolean;
};

const SYSTEM_ROLE_PERMISSION_CACHE = new Map<string, Set<string>>();

/**
 * Decide whether a policy's conditions allow it to apply in this request
 * context. Returns true when:
 *   - the policy has no conditions configured, OR
 *   - every configured condition passes.
 *
 * Treats unknown keys as no-ops so adding a new condition type in a future
 * release can't accidentally tighten an old policy. Treats malformed
 * values defensively: an invalid CIDR list is treated as "no IP matches",
 * which means the policy refuses to apply rather than silently allowing
 * everyone — fail-closed for the security-critical path.
 */
export function checkConditions(
  conditions: PolicyConditions | null | undefined,
  ctx: RequestContext,
): boolean {
  if (!conditions) return true;
  if (typeof conditions !== 'object') return true;

  if (conditions.require_mfa === true) {
    // Only count aal2 (Supabase's MFA-verified marker). aal1 = password
    // alone is not enough; missing aal claim is also a no-go.
    if (ctx.mfaAal !== 'aal2') return false;
  }

  const cidrs = conditions.ip_cidrs;
  if (Array.isArray(cidrs) && cidrs.length > 0) {
    if (!ctx.ip) return false; // no caller IP → can't satisfy the gate
    const parsed = parseCidrList(cidrs);
    if (parsed.length === 0) return false; // every entry was malformed
    if (!ipMatchesAny(ctx.ip, parsed)) return false;
  }

  return true;
}

// Small LRU-ish cache for parsed CIDR lists. Policies tend to repeat the
// same allowlist, and parseCidr does a lot of string work. Bounded so a
// pathological loader can't grow it unbounded.
const CIDR_PARSE_CACHE = new Map<string, ReturnType<typeof parseCidr>[]>();
const CIDR_PARSE_CACHE_MAX = 256;

function parseCidrList(list: readonly string[]): NonNullable<ReturnType<typeof parseCidr>>[] {
  const key = list.join('|');
  const cached = CIDR_PARSE_CACHE.get(key);
  if (cached) {
    return cached.filter((c): c is NonNullable<typeof c> => c !== null);
  }
  const parsed = list.map((c) => parseCidr(c));
  if (CIDR_PARSE_CACHE.size >= CIDR_PARSE_CACHE_MAX) {
    const firstKey = CIDR_PARSE_CACHE.keys().next().value;
    if (firstKey !== undefined) CIDR_PARSE_CACHE.delete(firstKey);
  }
  CIDR_PARSE_CACHE.set(key, parsed);
  return parsed.filter((c): c is NonNullable<typeof c> => c !== null);
}

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
  // Single round-trip: join account → account_member so we get the strict
  // mode flag alongside membership without a second query.
  const [member] = await db
    .select({
      isSuperAdmin: accountMembers.isSuperAdmin,
      accountRole: accountMembers.accountRole,
      iamStrictMode: accounts.iamStrictMode,
      mfaRequired: accounts.mfaRequired,
    })
    .from(accountMembers)
    .innerJoin(accounts, eq(accounts.accountId, accountMembers.accountId))
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
    iamStrictMode: member.iamStrictMode,
    accountMfaRequired: member.mfaRequired,
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
/**
 * Look up which project groups (if any) include the given project_id
 * within the account. Empty Set when the target isn't a project or
 * doesn't belong to any group. Cheap — single indexed SELECT.
 */
async function resolveProjectGroupsForTarget(
  accountId: string,
  target: AuthorizeTarget,
): Promise<Set<string>> {
  if (target.type !== 'project') return new Set();
  const rows = await db
    .select({ groupId: projectGroupMembers.groupId })
    .from(projectGroupMembers)
    .innerJoin(accounts, eq(accounts.accountId, accountId))
    .where(eq(projectGroupMembers.projectId, target.id));
  return new Set(rows.map((r) => r.groupId));
}

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
      conditions: iamPolicies.conditions,
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
        // Scope must be 'account' (Everything), match the required type,
        // OR be a project_group when we're authorising a project action
        // (the engine will resolve membership at match time).
        requiredScopeType === 'project'
          ? or(
              eq(iamPolicies.scopeType, 'account'),
              eq(iamPolicies.scopeType, 'project'),
              eq(iamPolicies.scopeType, 'project_group'),
            )
          : or(
              eq(iamPolicies.scopeType, 'account'),
              eq(iamPolicies.scopeType, requiredScopeType),
            ),
      ),
    );

  return rows.map((r) => ({
    scopeType: r.scopeType as PolicyScopeType,
    scopeId: r.scopeId,
    effect: r.effect as 'allow' | 'deny',
    conditions: (r.conditions ?? {}) as PolicyConditions,
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
  // Strict mode: refuse to fall back to the legacy bridge. Only super-admin
  // bypass + explicit IAM policies decide. This is the opt-in "IAM is the
  // single source of truth" mode.
  if (actor.iamStrictMode) return false;
  if (!actor.accountRole) return false;

  // Owner/admin keep the full Administrator bridge — that's what they had
  // before IAM and changing it would break every existing account.
  if (actor.accountRole === 'owner' || actor.accountRole === 'admin') {
    const actions = await getSystemRoleActions(SYSTEM_ROLE_KEY.ADMINISTRATOR);
    return actions.has(action);
  }

  // Member: account-level reads only. NO blanket project / sandbox / trigger
  // / channel access via the bridge — those come from explicit IAM policies
  // or project_members rows. This is what makes "limit user to one project"
  // actually work without requiring a deny policy on Everything.
  if (actor.accountRole === 'member') {
    return LEGACY_MEMBER_ACCOUNT_READS.has(action);
  }

  return false;
}

/**
 * Legacy project_members bridge. Pre-existing project access via the
 * project_members table is materialised as a synthetic Project Admin /
 * Editor / Viewer policy scoped to that project. In strict mode the bridge
 * is disabled entirely.
 */
async function bridgeLegacyProjectRole(
  actor: ResolvedActor,
  accountId: string,
  userId: string,
  projectId: string,
  action: string,
): Promise<boolean> {
  if (actor.iamStrictMode) return false;
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
 * Load policies attached directly to a PAT. Token policies are evaluated as
 * a SELF-CONTAINED set — Cloudflare-style "API token" semantics. When a
 * token has zero policies the engine falls back to the minter's permissions
 * (back-compat with the current "PAT inherits user" model). When the token
 * has ≥1 policy, ONLY those policies decide and the minter's permissions
 * (including super-admin bypass and legacy bridges) are ignored.
 */
async function loadTokenPolicies(
  accountId: string,
  tokenId: string,
  action: string,
  requiredScopeType: ResourceType,
): Promise<LoadedPolicy[]> {
  const rows = await db
    .select({
      scopeType: iamPolicies.scopeType,
      scopeId: iamPolicies.scopeId,
      effect: iamPolicies.effect,
      conditions: iamPolicies.conditions,
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
        eq(iamPolicies.principalType, 'token'),
        eq(iamPolicies.principalId, tokenId),
        requiredScopeType === 'project'
          ? or(
              eq(iamPolicies.scopeType, 'account'),
              eq(iamPolicies.scopeType, 'project'),
              eq(iamPolicies.scopeType, 'project_group'),
            )
          : or(
              eq(iamPolicies.scopeType, 'account'),
              eq(iamPolicies.scopeType, requiredScopeType),
            ),
      ),
    );
  return rows.map((r) => ({
    scopeType: r.scopeType as PolicyScopeType,
    scopeId: r.scopeId,
    effect: r.effect as 'allow' | 'deny',
    conditions: (r.conditions ?? {}) as PolicyConditions,
  }));
}

/** Cheap count to decide: does this token have ANY narrowing policy attached
 * (regardless of action)? Used by the engine to choose between "evaluate
 * token policies only" vs "fall back to user". */
async function tokenHasAnyPolicy(accountId: string, tokenId: string): Promise<boolean> {
  const [row] = await db
    .select({ policyId: iamPolicies.policyId })
    .from(iamPolicies)
    .where(
      and(
        eq(iamPolicies.accountId, accountId),
        eq(iamPolicies.principalType, 'token'),
        eq(iamPolicies.principalId, tokenId),
      ),
    )
    .limit(1);
  return !!row;
}

/**
 * Core authorization check. Returns Allow/Deny with a brief reason for
 * logging. When `actingTokenId` is set AND that token has at least one IAM
 * policy attached, the engine evaluates ONLY those policies (the request is
 * the token's identity, not the minter's). When the token has none, falls
 * through to user-based evaluation for back-compat with existing PATs.
 */
export async function authorize(
  userId: string,
  accountId: string,
  action: string,
  target?: AuthorizeTarget,
  actingTokenId?: string,
  requestCtx: RequestContext = {},
): Promise<AuthorizeResult> {
  const requiredScopeType = resourceTypeForAction(action);
  const effectiveTarget: AuthorizeTarget = target ?? { type: 'account' };

  // ── Token-as-principal path (Cloudflare-style API tokens) ──────────────
  // If the request came via a PAT AND that PAT has explicit narrowing
  // policies, evaluate ONLY the token policies. No super-admin bypass, no
  // legacy bridges, no inheritance from the minter. This is the safety
  // contract: a narrowed token can NEVER do more than its policies allow.
  if (actingTokenId && (await tokenHasAnyPolicy(accountId, actingTokenId))) {
    const [tokenPolicies, projectGroupIds] = await Promise.all([
      loadTokenPolicies(accountId, actingTokenId, action, requiredScopeType),
      resolveProjectGroupsForTarget(accountId, effectiveTarget),
    ]);
    let matchedAllow = false;
    for (const p of tokenPolicies) {
      if (!policyMatchesTarget(p, requiredScopeType, effectiveTarget, projectGroupIds)) continue;
      // Conditions filter applies before deny precedence — a deny whose
      // conditions don't match this request is simply not applicable.
      if (!checkConditions(p.conditions, requestCtx)) continue;
      if (p.effect === 'deny') {
        return { allowed: false, reason: 'token_explicit_deny' };
      }
      matchedAllow = true;
    }
    if (matchedAllow) {
      recordAllow({
        accountId,
        principalKind: 'token',
        principalId: actingTokenId,
        action,
      });
      return { allowed: true, reason: 'token_policy' };
    }
    return { allowed: false, reason: 'token_no_matching_policy' };
  }

  // ── User-as-principal path (existing flow) ─────────────────────────────
  const actor = await resolveActor(userId, accountId);
  if (!actor) {
    return { allowed: false, reason: 'not_a_member' };
  }

  // 1. Super-admin bypasses everything.
  if (actor.isSuperAdmin) {
    recordAllow({ accountId, principalKind: 'user', principalId: userId, action });
    return { allowed: true, reason: 'super_admin' };
  }

  // 1b. Account-wide MFA gate. When the account requires MFA AND the
  //     caller is on a browser/JWT session (no acting token), the AAL
  //     must be 'aal2'. Super-admins were already let through above so
  //     this can't permanently lock the account out. PATs are exempt —
  //     they gate via per-policy require_mfa conditions instead.
  if (
    actor.accountMfaRequired &&
    !actingTokenId &&
    requestCtx.mfaAal !== 'aal2'
  ) {
    return { allowed: false, reason: 'account_mfa_required' };
  }

  // Sanity: if the action expects a specific resource and we got an
  // account-level target, only an account-Everything policy can satisfy it.
  // That's fine — the SQL filter handles it. No early-out needed.

  // 2. Explicit policies (direct + via groups). Partition by effect; deny
  //    wins over allow on a per-action+scope basis.
  const [policies, projectGroupIds] = await Promise.all([
    loadGrantingPolicies(accountId, actor, userId, action, requiredScopeType),
    resolveProjectGroupsForTarget(accountId, effectiveTarget),
  ]);

  let matchedAllow = false;
  for (const p of policies) {
    if (!policyMatchesTarget(p, requiredScopeType, effectiveTarget, projectGroupIds)) continue;
    // Conditions filter — a policy whose conditions don't match this
    // request (wrong IP, missing MFA) is simply not applicable. A deny
    // gated by conditions is silent until the gate fires.
    if (!checkConditions(p.conditions, requestCtx)) continue;
    if (p.effect === 'deny') {
      // Explicit deny is final. Short-circuit immediately so a single deny
      // overrides any number of allows on the same action+scope.
      return { allowed: false, reason: 'explicit_deny' };
    }
    matchedAllow = true;
  }

  if (matchedAllow) {
    recordAllow({ accountId, principalKind: 'user', principalId: userId, action });
    return { allowed: true, reason: 'policy' };
  }

  // 3. Legacy bridges (only consulted when no explicit policy matched).
  //    Explicit denies above already short-circuited.
  if (await bridgeLegacyAccountRole(actor, action)) {
    recordAllow({ accountId, principalKind: 'user', principalId: userId, action });
    return { allowed: true, reason: 'legacy_account_role' };
  }

  if (
    effectiveTarget.type === 'project' &&
    (await bridgeLegacyProjectRole(actor, accountId, userId, effectiveTarget.id, action))
  ) {
    recordAllow({ accountId, principalKind: 'user', principalId: userId, action });
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
 *   - scope_type='project_group' AND target is project → matches when
 *     scope_id is in `targetProjectGroups` (pre-resolved by the caller)
 *
 * `targetProjectGroups` is the set of project_group IDs that contain
 * the target project (empty/undefined for non-project targets).
 *
 * Exported for unit tests.
 */
export function policyMatchesTarget(
  policy: LoadedPolicy,
  requiredScopeType: ResourceType,
  target: AuthorizeTarget,
  targetProjectGroups?: ReadonlySet<string>,
): boolean {
  if (policy.scopeType === 'account') return true;
  // Project-group scope only ever applies to a project target. NULL
  // scope_id on a project_group policy doesn't make sense (we never
  // mint those) and is treated as no-match.
  if (policy.scopeType === 'project_group') {
    if (target.type !== 'project') return false;
    if (!policy.scopeId) return false;
    return targetProjectGroups?.has(policy.scopeId) === true;
  }
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
  actingTokenId?: string,
  requestCtx?: RequestContext,
): Promise<void> {
  const result = await authorize(userId, accountId, action, target, actingTokenId, requestCtx);
  if (!result.allowed) {
    const err = new Error(`forbidden: ${action} (${result.reason ?? 'denied'})`);
    (err as Error & { status?: number }).status = 403;
    throw err;
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
  actingTokenId?: string,
  requestCtx: RequestContext = {},
): Promise<AccessibleResources> {
  // Token-as-principal short-circuit. When a PAT with narrowing policies
  // makes a list request, only its own policies decide what's visible —
  // the minter's super-admin status / group memberships / legacy bridges
  // are all ignored.
  if (actingTokenId && (await tokenHasAnyPolicy(accountId, actingTokenId))) {
    const rows = await loadTokenPolicies(accountId, actingTokenId, action, resourceType);
    let allowEverything = false;
    let denyEverything = false;
    const allowedIds = new Set<string>();
    const deniedIds = new Set<string>();
    const allowGroupIds = new Set<string>();
    const denyGroupIds = new Set<string>();
    for (const r of rows) {
      if (!checkConditions(r.conditions, requestCtx)) continue;
      if (r.scopeType === 'project_group' && resourceType === 'project') {
        if (!r.scopeId) continue;
        if (r.effect === 'deny') denyGroupIds.add(r.scopeId);
        else allowGroupIds.add(r.scopeId);
        continue;
      }
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
    if (allowGroupIds.size > 0 || denyGroupIds.size > 0) {
      const memberRows = await db
        .select({
          groupId: projectGroupMembers.groupId,
          projectId: projectGroupMembers.projectId,
        })
        .from(projectGroupMembers)
        .where(inArray(projectGroupMembers.groupId, [...allowGroupIds, ...denyGroupIds]));
      for (const row of memberRows) {
        if (denyGroupIds.has(row.groupId)) deniedIds.add(row.projectId);
        if (allowGroupIds.has(row.groupId)) allowedIds.add(row.projectId);
      }
    }
    if (denyEverything) return { mode: 'none' };
    if (allowEverything) return { mode: 'all_except', denied: deniedIds };
    for (const denied of deniedIds) allowedIds.delete(denied);
    return { mode: 'allow_only', allowed: allowedIds };
  }

  const actor = await resolveActor(userId, accountId);
  if (!actor) return { mode: 'none' };

  if (actor.isSuperAdmin) return { mode: 'all' };

  // Account-wide MFA gate — denies the entire list when the account
  // requires MFA and the caller isn't aal2 (browser/JWT only; PATs
  // already short-circuited above).
  if (
    actor.accountMfaRequired &&
    !actingTokenId &&
    requestCtx.mfaAal !== 'aal2'
  ) {
    return { mode: 'none' };
  }

  // Owner/admin legacy bridge always allows account-level reads/writes.
  // Preserves today's "owners see everything" without enumerating policies.
  if (
    (actor.accountRole === 'owner' || actor.accountRole === 'admin') &&
    (await bridgeLegacyAccountRole(actor, action))
  ) {
    return { mode: 'all' };
  }

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
      conditions: iamPolicies.conditions,
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
        resourceType === 'project'
          ? or(
              eq(iamPolicies.scopeType, 'account'),
              eq(iamPolicies.scopeType, 'project'),
              eq(iamPolicies.scopeType, 'project_group'),
            )
          : or(
              eq(iamPolicies.scopeType, 'account'),
              eq(iamPolicies.scopeType, resourceType),
            ),
      ),
    );

  let allowEverything = false;
  let denyEverything = false;
  const allowedIds = new Set<string>();
  const deniedIds = new Set<string>();
  // Project-group scopes we encounter; resolved to project IDs in
  // one batched query after the loop so the hot path doesn't fan out.
  const allowGroupIds = new Set<string>();
  const denyGroupIds = new Set<string>();

  for (const r of rows) {
    if (!checkConditions((r.conditions ?? {}) as PolicyConditions, requestCtx)) continue;
    if (r.scopeType === 'project_group' && resourceType === 'project') {
      if (!r.scopeId) continue;
      if (r.effect === 'deny') denyGroupIds.add(r.scopeId);
      else allowGroupIds.add(r.scopeId);
      continue;
    }
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

  // Expand any project_group scopes into the matching project IDs.
  if (allowGroupIds.size > 0 || denyGroupIds.size > 0) {
    const allGroupIds = [...allowGroupIds, ...denyGroupIds];
    const memberRows = await db
      .select({
        groupId: projectGroupMembers.groupId,
        projectId: projectGroupMembers.projectId,
      })
      .from(projectGroupMembers)
      .where(inArray(projectGroupMembers.groupId, allGroupIds));
    for (const row of memberRows) {
      if (denyGroupIds.has(row.groupId)) deniedIds.add(row.projectId);
      if (allowGroupIds.has(row.groupId)) allowedIds.add(row.projectId);
    }
  }

  // Legacy project_members bridge: any project_role row counts as an allow
  // for actions the bridged Project Admin/Editor/Viewer role would grant.
  // Only consulted for project listings AND only when strict mode is off.
  if (resourceType === 'project' && !actor.iamStrictMode) {
    const memberRows = await db
      .select({
        projectId: projectMembers.projectId,
        projectRole: projectMembers.projectRole,
      })
      .from(projectMembers)
      .where(
        and(eq(projectMembers.accountId, accountId), eq(projectMembers.userId, userId)),
      );

    for (const m of memberRows) {
      const key =
        m.projectRole === 'manager'
          ? SYSTEM_ROLE_KEY.PROJECT_ADMIN
          : m.projectRole === 'editor'
            ? SYSTEM_ROLE_KEY.PROJECT_EDITOR
            : SYSTEM_ROLE_KEY.PROJECT_VIEWER;
      const actions = await getSystemRoleActions(key);
      if (actions.has(action)) allowedIds.add(m.projectId);
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
