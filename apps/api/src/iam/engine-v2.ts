// IAM V2 engine. The only authorization path — the V1 policy engine and
// its accounts.iam_v2_enabled rollout flag were retired in PR5.
//
// Decides access from three tables:
//   - account_members         (account_role, is_super_admin)
//   - project_members         (direct per-user project_role)
//   - project_group_grants    (group → project → project_role, expanded
//                               via account_group_members)
//
// No iam_policies. No scope grammar. No conditions. No deny precedence.
// One role determines what you can do at the level that role applies.
//
// The pure-function helpers (deriveEffectiveProjectRole, scopeForAction)
// are exported so they can be unit-tested without a DB.

import { and, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  accountGroupMembers,
  accountMembers,
  accountTokens,
  accounts,
  projectGroupGrants,
  projectMembers,
  projects,
} from '@kortix/db';
import { db } from '../shared/db';
import { ttlMemo } from '../shared/ttl-memo';
import type {
  AuthorizeResult,
  AuthorizeTarget,
  RequestContext,
} from './engine';
import {
  ACCOUNT_ROLE_PERMS,
  PROJECT_ROLE_PERMS,
  accountRoleAllows,
  implicitProjectRoleForAccount,
  maxProjectRole,
  projectRoleAllows,
  type AccountRole,
  type ProjectRole,
} from './role-perms';

// ─── Pure helpers (exported for unit tests) ────────────────────────────────

export type ActionScopeV2 = 'account' | 'project';

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

type ResolvedActorV2 = {
  isSuperAdmin: boolean;
  accountRole: AccountRole | null;
  groupIds: string[];
  accountMfaRequired: boolean;
};

async function resolveActorV2Uncached(
  userId: string,
  accountId: string,
): Promise<ResolvedActorV2 | null> {
  const [memberRows, groups] = await Promise.all([
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
  ]);
  const member = memberRows[0];
  if (!member) return null;

  return {
    isSuperAdmin: member.isSuperAdmin,
    accountRole: (member.accountRole as AccountRole | null) ?? null,
    groupIds: groups.map((g) => g.groupId),
    accountMfaRequired: member.mfaRequired,
  };
}

const resolveActorV2 = ttlMemo({
  ttlMs: IAM_CACHE_TTL_MS,
  keyFn: (userId: string, accountId: string) => `${userId}|${accountId}`,
  loader: resolveActorV2Uncached,
  shouldCache: (actor) => actor !== null,
});

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
  loader: async (tokenId: string): Promise<{ projectId: string | null } | null> => {
    const [row] = await db
      .select({ projectId: accountTokens.projectId })
      .from(accountTokens)
      .where(eq(accountTokens.tokenId, tokenId))
      .limit(1);
    return row ?? null;
  },
  shouldCache: (row) => row !== null,
});

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
  // request isn't on that project, deny before we even look at perms.
  if (!patInScope) {
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

  const accountRole = actor.accountRole ?? 'member';

  if (scope === 'account') {
    return accountRoleAllows(accountRole, action)
      ? { allowed: true, reason: 'account_role' }
      : { allowed: false, reason: 'account_role_insufficient' };
  }

  // Project scope. The action requires a project target.
  if (effectiveTarget.type !== 'project') {
    return { allowed: false, reason: 'project_target_required' };
  }

  const effective = await loadEffectiveProjectRole(actor, userId, effectiveTarget.id);
  if (!effective) {
    return { allowed: false, reason: 'no_project_membership' };
  }
  return projectRoleAllows(effective, action)
    ? { allowed: true, reason: 'project_role' }
    : { allowed: false, reason: 'project_role_insufficient' };
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
  if (actingTokenId) {
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
  return { mode: 'allow_only', allowed };
}

/** Thin assertion wrapper matching V1's `assertAuthorized`. */
export async function assertAuthorizedV2(
  userId: string,
  accountId: string,
  action: string,
  target?: AuthorizeTarget,
  actingTokenId?: string,
  requestCtx?: RequestContext,
): Promise<void> {
  const result = await authorizeV2(
    userId,
    accountId,
    action,
    target,
    actingTokenId,
    requestCtx,
  );
  if (!result.allowed) {
    const err = new Error(`forbidden: ${action} (${result.reason ?? 'denied'})`);
    (err as Error & { status?: number }).status = 403;
    throw err;
  }
}

// ─── Suppress unused-locals warnings ───────────────────────────────────────
// PERMS exports are kept for future use by the policies-replacement UI.
export const _V2_INTERNALS = { ACCOUNT_ROLE_PERMS, PROJECT_ROLE_PERMS };
