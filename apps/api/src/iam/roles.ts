// The role VOCABULARY: the two role-key unions, and the two parsers that turn a
// stored value or a request body into one.
//
// This is all that survives of `iam/role-perms.ts`. What went with the cutover:
//   ACCOUNT_ROLE_PERMS / PROJECT_ROLE_PERMS  the per-role permission Sets. They
//     are rows now — `kortix.role_permissions`, read through
//     `iam/catalog.ts loadSystemRoles()`.
//   accountRoleAllows / projectRoleAllows    Set.has() against those Sets. The
//     engine expands roles from the DB instead.
//   implicitProjectRoleForAccount            "owner/admin get Manager on every
//     project" is a SCOPE-CONTAINMENT rule in `authorize.ts`
//     (`isImplicitManager`), not a role lookup.
//
// The two unions stay in CODE, not in the DB, on purpose: they are the shape of
// a request body and a route parameter — `role: 'manager' | 'member'` — and a
// route has to reject a bad value with a 400 before any store is consulted.

export type AccountRole = 'owner' | 'admin' | 'member';
export type ProjectRole = 'manager' | 'member';

/**
 * Coerce a STORED role value (a DB column, a legacy token claim, an old
 * invite's bootstrap grant) into a canonical ProjectRole. Every retired tier
 * folds: `user`/`viewer` → `member`, `editor` → `manager`.
 *
 * Reads must never fail on a value the database can legitimately still hold:
 * `kortix.project_role` still carries the undroppable `editor` and `viewer`
 * labels, and during a rollout a pre-removal replica can still write `editor`.
 * The SQL half of this fold is `kortix.rbac_project_role_key()`, used by the
 * compatibility views' INSTEAD OF triggers — the two must agree.
 *
 * Returns null for anything unrecognized, including non-string input.
 * Do NOT use this on a request body — see `parseAssignableProjectRole`.
 */
export function normalizeProjectRole(raw: unknown): ProjectRole | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  if (v === 'viewer' || v === 'user') return 'member';
  if (v === 'editor') return 'manager';
  return v === 'manager' || v === 'member' ? v : null;
}

/** The exact wording every route uses when a role body value is rejected.
 *  One string, one place — the `editor` half is what an old client sees. */
export const PROJECT_ROLE_INPUT_ERROR =
  'role must be one of manager|member (the editor role was removed — assign manager for full project control, or member for read + run)';

/**
 * Parse a role that a CALLER asked us to ASSIGN (request body). Strict where
 * `normalizeProjectRole` is lenient: `editor` is rejected, not folded. Folding
 * it would silently hand a caller who asked for the middle tier full project
 * control — including member management and delete. Making them say `manager`
 * keeps that an explicit act.
 *
 * `user`/`viewer` still fold to `member`: those were RENAMES of the same
 * permission tier, so accepting them grants exactly what the caller asked for.
 */
export function parseAssignableProjectRole(raw: unknown): ProjectRole | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  if (v === 'viewer' || v === 'user') return 'member';
  return v === 'manager' || v === 'member' ? v : null;
}

/** Owner and admin are the account-manager tier: implicit Manager on every
 *  project in the account. */
export function isAccountManager(role: AccountRole | string | null): boolean {
  return role === 'owner' || role === 'admin';
}

/**
 * The ONE role ladder of a workspace (design.md §3.2 C3), strongest first:
 * owner > admin > manager > member. Storage keeps the two scopes in R1:
 * owner/admin = the account-scope system role; manager = account `member` +
 * project `manager` on the workspace's project; member = account `member`
 * (membership is access).
 */
export type WorkspaceRole = 'owner' | 'admin' | 'manager' | 'member';
export const WORKSPACE_ROLES: readonly WorkspaceRole[] = ['owner', 'admin', 'manager', 'member'];

/** Parse a ladder role from a request body; null for anything else. */
export function parseWorkspaceRole(raw: unknown): WorkspaceRole | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  return (WORKSPACE_ROLES as readonly string[]).includes(v) ? (v as WorkspaceRole) : null;
}

/** The account-scope system role that stores a ladder role. */
export function accountRoleForWorkspaceRole(role: WorkspaceRole): AccountRole {
  return role === 'owner' || role === 'admin' ? role : 'member';
}

/**
 * A member's ladder role from the two stored rows: the account-scope system
 * role, and the system project role held on the workspace's project (null when
 * none). The pure half of `workspaceRoleFor`, for a list that already holds
 * every member's rows (the Members table).
 */
export function workspaceRoleFromRows(accountRole: string | null, projectRoleOnWorkspace: string | null): WorkspaceRole | null {
  if (accountRole === 'owner' || accountRole === 'admin') return accountRole;
  if (projectRoleOnWorkspace === 'manager') return 'manager';
  if (accountRole === 'member' || projectRoleOnWorkspace === 'member') return 'member';
  return null;
}
