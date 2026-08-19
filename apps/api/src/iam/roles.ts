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

/** Ordering for "the strongest role wins" folds. */
export const PROJECT_ROLE_RANK: Record<ProjectRole, number> = {
  member: 1,
  manager: 2,
};

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

/** The higher-ranked of two project roles. Used when a principal's effective
 *  role comes from several sources (direct membership + group grants) — they get
 *  the strongest of the bunch. */
export function maxProjectRole(a: ProjectRole, b: ProjectRole): ProjectRole {
  return PROJECT_ROLE_RANK[a] >= PROJECT_ROLE_RANK[b] ? a : b;
}

/** Owner and admin are the account-manager tier: implicit Manager on every
 *  project in the account. */
export function isAccountManager(role: AccountRole | string | null): boolean {
  return role === 'owner' || role === 'admin';
}
