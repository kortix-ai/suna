// IAM V2 engine. The only authorization path — the V1 policy engine and
// its accounts.iam_v2_enabled rollout flag were retired in PR5.
//
// Decides access from the built-in role tables…
//   - account_members         (account_role, is_super_admin)
//   - project_members         (direct per-user project_role)
//   - project_group_grants    (group → project → project_role, expanded
//                               via account_group_members)
// …UNIONED (allow-only, highest-wins) with DB-driven custom roles (IAM v1):
//   - iam_policies + iam_role_actions  (member/group principal → custom role's
//                                        action set, at account or project scope)
//
// No deny precedence, no conditions. The built-in role is the fast path; a
// custom policy can only ADD actions, never remove — so built-in roles behave
// exactly as before and the union is inert until an admin creates a custom role.
//
// The pure-function helpers (deriveEffectiveProjectRole, scopeForActionV2,
// customPolicyAllows) are exported so they can be unit-tested without a DB.

import { and, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  accountGroupMembers,
  accountMembers,
  accountTokens,
  accounts,
  iamPolicies,
  iamRoleActions,
  projectGroupGrants,
  projectMembers,
  projects,
  serviceAccounts,
  type AgentGrant,
} from '@kortix/db';
import { db } from '../shared/db';
import { ttlMemo } from '../shared/ttl-memo';
import { agentMayPerform } from './agent-scope';
import { registerPrincipalScopedMemo } from './cache-invalidation';
import type {
  AuthorizeResult,
  AuthorizeTarget,
  RequestContext,
} from './engine';
import {
  accountRoleAllows,
  implicitProjectRoleForAccount,
  maxProjectRole,
  projectRoleAllows,
  type AccountRole,
  type ProjectRole,
} from './role-perms';

// ─── Pure helpers (exported for unit tests) ────────────────────────────────

type ActionScopeV2 = 'account' | 'project';

/**
 * V2 scope detection. V2 collapses sandbox/trigger/channel into the
 * project they belong to — callers always pass a project target for
 * those actions. account.*, billing.*, audit.*, member.*, group.*,
 * role.*, policy.*, token.* and project.create are account-level;
 * everything else is project-level.
 */
export function scopeForActionV2(action: string): ActionScopeV2 {
  if (action === 'project.create') return 'account';
  if (
    action.startsWith('account.') ||
    action.startsWith('billing.') ||
    action.startsWith('audit.') ||
    action.startsWith('member.') ||
    action.startsWith('group.') ||
    action.startsWith('role.') ||
    action.startsWith('policy.') ||
    action.startsWith('token.')
  ) {
    return 'account';
  }
  return 'project';
}

/**
 * Combine the three possible sources of a user's project role into one
 * effective role. Returns null when the user has no path to the project.
 *
 *   accountRole = 'owner' | 'admin' | 'member'
 *   directRole  = project_members.project_role (or null when no direct row)
 *   groupRoles  = [] of project_group_grants.role rows for groups the user is in
 */
export function deriveEffectiveProjectRole(
  accountRole: AccountRole,
  directRole: ProjectRole | null,
  groupRoles: readonly ProjectRole[],
): ProjectRole | null {
  // Owner/admin: implicit Manager on every project in the account. Group
  // and direct rows can't elevate further; nothing can demote below this.
  const implicit = implicitProjectRoleForAccount(accountRole);
  let best: ProjectRole | null = implicit;

  if (directRole) {
    best = best ? maxProjectRole(best, directRole) : directRole;
  }
  for (const r of groupRoles) {
    best = best ? maxProjectRole(best, r) : r;
  }
  return best;
}

// ─── DB lookups ────────────────────────────────────────────────────────────
//
// LATENCY NOTE (prod incident, 2026-06-12): every DB statement from the prod
// fleet pays a cross-region roundtrip, and these principal lookups run on
// every single authed request — often 10+ times in parallel during one page
// load. Two levers keep that off the floor of every request:
//   1. Independent queries run via Promise.all (depth, not count, costs time).
//   2. Results are memoized for a short TTL (IAM_CACHE_TTL_MS, default 15s) —
//      *positive* results only, so a freshly granted member sees access
//      immediately while a revoked one keeps it for at most one TTL window.

const IAM_CACHE_TTL_MS = (() => {
  const raw = Number(process.env.IAM_CACHE_TTL_MS);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 15_000;
})();

/** A custom-role action this actor holds, with the scope it applies at.
 *  scopeType 'account' grants everywhere; 'project' grants only on scopeId. */
export type CustomAction = { scopeType: string; scopeId: string | null; action: string };

type ResolvedActorV2 = {
  /** 'member' = a human (account_members row). 'service_account' = a machine
   *  identity (service_accounts row) whose ONLY authority is its own iam_policies
   *  (principal_type='token') — no built-in role, no membership baseline. */
  kind: 'member' | 'service_account';
  isSuperAdmin: boolean;
  accountRole: AccountRole | null;
  groupIds: string[];
  accountMfaRequired: boolean;
  /** Actions granted by DB custom roles via iam_policies (member + group
   *  principals for a human; the token principal for a service account). Empty
   *  for the common no-custom-roles account. */
  customActions: CustomAction[];
};

async function resolveActorV2Uncached(
  userId: string,
  accountId: string,
): Promise<ResolvedActorV2 | null> {
  // The custom-policy query is self-contained (group membership via a subquery)
  // so all three run in ONE parallel batch — no added latency depth. It returns
  // [] for the overwhelmingly common account with no custom roles.
  const [memberRows, groups, policyRows] = await Promise.all([
    db
      .select({
        isSuperAdmin: accountMembers.isSuperAdmin,
        accountRole: accountMembers.accountRole,
        mfaRequired: accounts.mfaRequired,
      })
      .from(accountMembers)
      .innerJoin(accounts, eq(accounts.accountId, accountMembers.accountId))
      .where(and(eq(accountMembers.userId, userId), eq(accountMembers.accountId, accountId)))
      .limit(1),
    db
      .select({ groupId: accountGroupMembers.groupId })
      .from(accountGroupMembers)
      .where(eq(accountGroupMembers.userId, userId)),
    db
      .select({
        scopeType: iamPolicies.scopeType,
        scopeId: iamPolicies.scopeId,
        action: iamRoleActions.action,
      })
      .from(iamPolicies)
      .innerJoin(iamRoleActions, eq(iamRoleActions.roleId, iamPolicies.roleId))
      .where(
        and(
          eq(iamPolicies.accountId, accountId),
          or(isNull(iamPolicies.expiresAt), gt(iamPolicies.expiresAt, sql`now()`)),
          or(
            and(eq(iamPolicies.principalType, 'member'), eq(iamPolicies.principalId, userId)),
            and(
              eq(iamPolicies.principalType, 'group'),
              inArray(
                iamPolicies.principalId,
                db
                  .select({ gid: accountGroupMembers.groupId })
                  .from(accountGroupMembers)
                  .where(eq(accountGroupMembers.userId, userId)),
              ),
            ),
            // Service-account principal: a token policy keyed on this id. Harmless
            // for a human request (SA ids and user ids are disjoint uuids, so this
            // matches nothing), load-bearing for an SA request (its standing role).
            and(eq(iamPolicies.principalType, 'token'), eq(iamPolicies.principalId, userId)),
          ),
        ),
      ),
  ]);
  const customActions: CustomAction[] = policyRows.map((r) => ({
    scopeType: r.scopeType,
    scopeId: r.scopeId,
    action: r.action,
  }));

  const member = memberRows[0];
  if (member) {
    return {
      kind: 'member',
      isSuperAdmin: member.isSuperAdmin,
      accountRole: (member.accountRole as AccountRole | null) ?? null,
      groupIds: groups.map((g) => g.groupId),
      accountMfaRequired: member.mfaRequired,
      customActions,
    };
  }

  // Not a human member — is this id a service account in this account? (Rare
  // path: only SA-authenticated requests and genuinely-unknown ids reach here,
  // so the extra query never touches the hot human/PAT path.) A service account
  // has NO membership baseline and NO built-in role: its entire authority is its
  // own iam_policies (principal_type='token'), already loaded into customActions.
  const saRows = await db
    .select({ id: serviceAccounts.serviceAccountId })
    .from(serviceAccounts)
    .where(
      and(
        eq(serviceAccounts.serviceAccountId, userId),
        eq(serviceAccounts.accountId, accountId),
        eq(serviceAccounts.status, 'active'),
      ),
    )
    .limit(1);
  if (saRows[0]) {
    return {
      kind: 'service_account',
      isSuperAdmin: false,
      accountRole: null,
      groupIds: [],
      accountMfaRequired: false,
      customActions,
    };
  }

  return null;
}

/**
 * Does a DB custom policy grant `action` at this scope? Allow-only union with
 * the built-in role: an account-scoped policy grants the action everywhere; a
 * project-scoped policy grants it only on its own project. Pure (exported for
 * unit tests) — operates on the actor's resolved customActions.
 */
export function customPolicyAllows(
  customActions: CustomAction[],
  scope: ActionScopeV2,
  action: string,
  target: AuthorizeTarget,
): boolean {
  if (customActions.length === 0) return false;
  for (const ca of customActions) {
    if (ca.action !== action) continue;
    if (ca.scopeType === 'account') return true;
    if (scope === 'project' && target.type === 'project' && ca.scopeType === 'project' && ca.scopeId === target.id) {
      return true;
    }
  }
  return false;
}

const resolveActorV2 = ttlMemo({
  ttlMs: IAM_CACHE_TTL_MS,
  keyFn: (userId: string, accountId: string) => `${userId}|${accountId}`,
  loader: resolveActorV2Uncached,
  shouldCache: (actor) => actor !== null,
});
// Key is `${userId}|…` → bust per principal on account-member / group-membership
// changes (see cache-invalidation.ts).
registerPrincipalScopedMemo(resolveActorV2);

/**
 * Look up the actor's effective role on a specific project. Combines
 * the direct project_members row (if any) with every project_group_grants
 * row for any group the user belongs to. Returns null when there's no
 * path at all and the actor isn't an account admin/owner.
 */
// Time-bounded grants: a row whose expires_at is in the past is
// effectively gone. Filter at the SQL layer so the row is invisible
// to every authorize() call the moment the clock crosses the line —
// no waiting on the sweeper. (The sweeper just emits the audit
// event afterwards; correctness doesn't depend on it.)
const loadProjectRoleRows = ttlMemo({
  ttlMs: IAM_CACHE_TTL_MS,
  keyFn: (userId: string, projectId: string, groupIds: string[]) =>
    `${userId}|${projectId}|${groupIds.join(',')}`,
  loader: async (userId: string, projectId: string, groupIds: string[]) => {
    const [directRows, grantRows] = await Promise.all([
      db
        .select({ role: projectMembers.projectRole })
        .from(projectMembers)
        .where(
          and(
            eq(projectMembers.projectId, projectId),
            eq(projectMembers.userId, userId),
            or(
              isNull(projectMembers.expiresAt),
              gt(projectMembers.expiresAt, sql`now()`),
            ),
          ),
        )
        .limit(1),
      groupIds.length > 0
        ? db
            .select({ role: projectGroupGrants.role })
            .from(projectGroupGrants)
            .where(
              and(
                eq(projectGroupGrants.projectId, projectId),
                inArray(projectGroupGrants.groupId, groupIds),
                or(
                  isNull(projectGroupGrants.expiresAt),
                  gt(projectGroupGrants.expiresAt, sql`now()`),
                ),
              ),
            )
        : Promise.resolve([] as Array<{ role: string }>),
    ]);
    return {
      directRole: (directRows[0]?.role as ProjectRole | undefined) ?? null,
      groupRoles: grantRows.map((r) => r.role as ProjectRole),
    };
  },
  // Never cache "no path to this project" — a freshly granted member must
  // see access on their next request, not after a TTL window.
  shouldCache: (v) => v.directRole !== null || v.groupRoles.length > 0,
});
// Key is `${userId}|${projectId}|…` → bust per principal on project-member /
// project-group-grant changes.
registerPrincipalScopedMemo(loadProjectRoleRows);

async function loadEffectiveProjectRole(
  actor: ResolvedActorV2,
  userId: string,
  projectId: string,
): Promise<ProjectRole | null> {
  const accountRole = actor.accountRole ?? 'member';

  // Owner/admin carry implicit Manager — the per-project rows can only tie,
  // never exceed it (manager is the top rank), so skip the lookups entirely.
  if (implicitProjectRoleForAccount(accountRole)) return 'manager';

  const rows = await loadProjectRoleRows(userId, projectId, actor.groupIds);
  return deriveEffectiveProjectRole(accountRole, rows.directRole, rows.groupRoles);
}

/**
 * PAT scope check. A PAT bound to a specific project (account_tokens.project_id
 * set) is refused on any request whose target is a different project, or
 * on account-level requests entirely. Returns true when the PAT is in
 * scope for this request, false when it should be denied.
 */
// A token's project binding is immutable after mint, so caching it is safe;
// "token row missing" is never cached (a just-minted token must work, and
// revocation is enforced upstream by validateAccountToken at auth time).
const loadTokenProjectBinding = ttlMemo({
  ttlMs: IAM_CACHE_TTL_MS,
  keyFn: (tokenId: string) => tokenId,
  loader: async (
    tokenId: string,
  ): Promise<{ projectId: string | null; agentGrant: AgentGrant | null } | null> => {
    const [row] = await db
      .select({ projectId: accountTokens.projectId, agentGrant: accountTokens.agentGrant })
      .from(accountTokens)
      .where(eq(accountTokens.tokenId, tokenId))
      .limit(1);
    return row ? { projectId: row.projectId, agentGrant: row.agentGrant ?? null } : null;
  },
  shouldCache: (row) => row !== null,
});

// A project action that an agent grant SHOULD gate. The coarse membership
// actions (read/write, what loadProjectForUser maps onto) are exempt: a route
// that does loadProjectForUser('write') is just checking membership tier, and a
// leaf-scoped agent (e.g. kortixCli=['project.gitops.push']) must still pass it —
// the route's own leaf assertAuthorized is what the grant gates. Every OTHER
// project action (gitops.*, secret.*, trigger.*, deploy, members.manage, …) is a
// specific capability the agent must hold in its grant.
const AGENT_GRANT_EXEMPT_ACTIONS: ReadonlySet<string> = new Set([
  'project.read',
  'project.write',
]);

/** Should the agent grant gate this action? Pure — exported for unit tests. */
export function agentGrantGates(scope: ActionScopeV2, action: string): boolean {
  return scope === 'project' && !AGENT_GRANT_EXEMPT_ACTIONS.has(action);
}

async function tokenInScope(
  actingTokenId: string,
  scope: ActionScopeV2,
  target: AuthorizeTarget,
): Promise<boolean> {
  const row = await loadTokenProjectBinding(actingTokenId);
  if (!row) return false;
  if (!row.projectId) return true; // unscoped PAT — falls through to user perms
  // Project-scoped PAT.
  if (scope === 'account') return false;
  if (target.type !== 'project') return false;
  return target.id === row.projectId;
}

// ─── Public surface ────────────────────────────────────────────────────────

/**
 * Core authorization check. Same signature as V1 `authorize` so the
 * dispatch layer can swap them. requestCtx kept for compatibility but
 * unused — V2 has no policy conditions.
 */
export async function authorizeV2(
  userId: string,
  accountId: string,
  action: string,
  target?: AuthorizeTarget,
  actingTokenId?: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _requestCtx: RequestContext = {},
): Promise<AuthorizeResult> {
  const scope = scopeForActionV2(action);
  const effectiveTarget: AuthorizeTarget = target ?? { type: 'account' };

  // Actor resolve and PAT scope check are independent — overlap them so a
  // token-authed request pays one roundtrip of latency, not two.
  const [actor, patInScope] = await Promise.all([
    resolveActorV2(userId, accountId),
    actingTokenId
      ? tokenInScope(actingTokenId, scope, effectiveTarget)
      : Promise.resolve(true),
  ]);
  if (!actor) return { allowed: false, reason: 'not_a_member' };

  // PAT scope short-circuit. If the token is project-bound and this
  // request isn't on that project, deny before we even look at perms. Applies
  // only to human/PAT principals — a service account is not a project-bound PAT
  // (its acting id is its own principal id, absent from account_tokens), so the
  // PAT scope verdict is meaningless for it.
  if (actor.kind === 'member' && !patInScope) {
    return { allowed: false, reason: 'token_out_of_scope' };
  }

  // Super-admin bypasses everything else (including MFA gate — flipping
  // the account-MFA toggle must never permanently lock the account out).
  if (actor.isSuperAdmin) {
    return { allowed: true, reason: 'super_admin' };
  }

  // Account-wide MFA gate. JWT/browser sessions only — PATs gate via
  // their own surface (we just verified scope above).
  if (
    actor.accountMfaRequired &&
    !actingTokenId &&
    _requestCtx.mfaAal !== 'aal2'
  ) {
    return { allowed: false, reason: 'account_mfa_required' };
  }

  if (scope === 'account') {
    // A service account has NO membership baseline — its entire authority is its
    // own policies. Only a human member gets the built-in account-role check.
    if (actor.kind === 'member' && accountRoleAllows(actor.accountRole ?? 'member', action)) {
      return { allowed: true, reason: 'account_role' };
    }
    // Built-in role denied (or SA) → DB custom roles (allow-only union).
    if (customPolicyAllows(actor.customActions, scope, action, effectiveTarget)) {
      return { allowed: true, reason: 'custom_policy' };
    }
    return { allowed: false, reason: 'account_role_insufficient' };
  }

  // Project scope. The action requires a project target.
  if (effectiveTarget.type !== 'project') {
    return { allowed: false, reason: 'project_target_required' };
  }

  // A custom policy can grant access even with NO built-in project role (the
  // department case: a member bound to a scoped custom role via iam_policies and
  // no project_members/group GRANT row), so resolve the built-in role but treat
  // it as one source in the union, not a gate.
  // A service account has no project membership — its project access comes only
  // from its own project-scoped (or account-scoped) policies, so skip the
  // member-role resolution entirely for it.
  const effective =
    actor.kind === 'member'
      ? await loadEffectiveProjectRole(actor, userId, effectiveTarget.id)
      : null;
  let reason: string | null = null;
  if (effective && projectRoleAllows(effective, action)) reason = 'project_role';
  else if (customPolicyAllows(actor.customActions, scope, action, effectiveTarget)) reason = 'custom_policy';

  if (!reason) {
    if (actor.kind === 'service_account') return { allowed: false, reason: 'service_account_scope_insufficient' };
    if (!effective) return { allowed: false, reason: 'no_project_membership' };
    return { allowed: false, reason: 'project_role_insufficient' };
  }

  // userRole ∩ agentGrant — the central enforcement. A scoped agent session
  // token can never exceed its kortix.toml kortixCli on a specific capability,
  // EVEN when the launching user would be allowed. This matters most because
  // automation sessions (Slack/cron/trigger) run AS AN ACCOUNT OWNER, so the
  // role half grants everything — the agent grant is the only real containment
  // for exactly those sessions. Enforced here (not per-route) so it can't be
  // forgotten on a new route. No-op for non-agent tokens (null grant) and
  // 'all' grants; exempt for the coarse membership actions (read/write).
  if (actingTokenId && agentGrantGates(scope, action)) {
    const binding = await loadTokenProjectBinding(actingTokenId); // memoized — same entry as tokenInScope
    if (!agentMayPerform(binding?.agentGrant ?? null, action)) {
      return { allowed: false, reason: 'agent_scope_insufficient' };
    }
  }
  return { allowed: true, reason };
}

// ─── List accessible resources ─────────────────────────────────────────────

export type AccessibleResourcesV2 =
  | { mode: 'all' }
  | { mode: 'none' }
  | { mode: 'allow_only'; allowed: Set<string> };

/**
 * Returns the set of project IDs the user can perform `action` on.
 * Used by list endpoints to filter without N×authorize round-trips.
 *
 * V2 only supports projectresource type — sandboxes/triggers/channels
 * are listed via their owning project, not standalone.
 */
export async function listAccessibleProjectsV2(
  userId: string,
  accountId: string,
  action: string,
  actingTokenId?: string,
  _requestCtx: RequestContext = {},
): Promise<AccessibleResourcesV2> {
  const actor = await resolveActorV2(userId, accountId);
  if (!actor) return { mode: 'none' };

  // PAT bound to a single project narrows the listing to just that project.
  // Human/PAT principals only — a service account's acting id is its own
  // principal id (not an account_tokens row), so skip this and let its own
  // policies drive the listing (folded in below), or it would wrongly resolve
  // to mode:'none'.
  if (actingTokenId && actor.kind === 'member') {
    const [row] = await db
      .select({ projectId: accountTokens.projectId })
      .from(accountTokens)
      .where(eq(accountTokens.tokenId, actingTokenId))
      .limit(1);
    if (!row) return { mode: 'none' };
    if (row.projectId) {
      // Confirm the user has access to that project; reuse authorize.
      const v = await authorizeV2(
        userId,
        accountId,
        action,
        { type: 'project', id: row.projectId },
        actingTokenId,
      );
      return v.allowed ? { mode: 'allow_only', allowed: new Set([row.projectId]) } : { mode: 'none' };
    }
  }

  if (actor.isSuperAdmin) return { mode: 'all' };

  if (
    actor.accountMfaRequired &&
    !actingTokenId &&
    _requestCtx.mfaAal !== 'aal2'
  ) {
    return { mode: 'none' };
  }

  const accountRole = actor.accountRole ?? 'member';

  // Owner/admin: implicit Manager on every project. Allowed unless the
  // action isn't in Manager's set.
  if (implicitProjectRoleForAccount(accountRole)) {
    return projectRoleAllows('manager', action)
      ? { mode: 'all' }
      : { mode: 'none' };
  }

  // Plain member: union of direct project_members + group-derived grants.
  // For each project, compute effective role and check if it allows the
  // action. Cheap because the union is bounded by membership count.
  const notExpiredMember = or(
    isNull(projectMembers.expiresAt),
    gt(projectMembers.expiresAt, sql`now()`),
  );
  const notExpiredGrant = or(
    isNull(projectGroupGrants.expiresAt),
    gt(projectGroupGrants.expiresAt, sql`now()`),
  );

  const directRows = await db
    .select({
      projectId: projectMembers.projectId,
      role: projectMembers.projectRole,
    })
    .from(projectMembers)
    .innerJoin(projects, eq(projects.projectId, projectMembers.projectId))
    .where(
      and(
        eq(projectMembers.userId, userId),
        eq(projects.accountId, accountId),
        notExpiredMember,
      ),
    );

  let groupRows: Array<{ projectId: string; role: ProjectRole }> = [];
  if (actor.groupIds.length > 0) {
    const rows = await db
      .select({
        projectId: projectGroupGrants.projectId,
        role: projectGroupGrants.role,
      })
      .from(projectGroupGrants)
      .where(
        and(
          eq(projectGroupGrants.accountId, accountId),
          inArray(projectGroupGrants.groupId, actor.groupIds),
          notExpiredGrant,
        ),
      );
    groupRows = rows.map((r) => ({
      projectId: r.projectId,
      role: r.role as ProjectRole,
    }));
  }

  // Merge by max-role per project, then filter by action.
  const byProject = new Map<string, ProjectRole>();
  for (const r of directRows) {
    byProject.set(r.projectId, r.role as ProjectRole);
  }
  for (const r of groupRows) {
    const existing = byProject.get(r.projectId);
    byProject.set(r.projectId, existing ? maxProjectRole(existing, r.role) : r.role);
  }

  const allowed = new Set<string>();
  for (const [projectId, role] of byProject) {
    if (projectRoleAllows(role, action)) allowed.add(projectId);
  }
  // Fold in DB custom roles (union): an account-scoped policy granting this
  // action covers every project; a project-scoped one adds just its project —
  // so a department member sees the company project even with no built-in role.
  for (const ca of actor.customActions) {
    if (ca.action !== action) continue;
    if (ca.scopeType === 'account') return { mode: 'all' };
    if (ca.scopeType === 'project' && ca.scopeId) allowed.add(ca.scopeId);
  }
  return { mode: 'allow_only', allowed };
}
