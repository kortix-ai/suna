// IAM V2 role → permissions mapping. Single source of truth, in code.
//
// Six fixed roles, no DB-driven role table:
//   account: owner > admin > member
//   project: manager > editor > viewer
//
// `>` means "strict superset" within the same axis. Owner has everything
// admin has, admin has everything member has, etc. Per-role sets below
// are the *full* permission set (not the delta), so the engine just does
// a Set.has() — no inheritance walk at request time.
//
// V1 lives alongside this for as long as the iam_v2_enabled flag is
// false; the engine dispatches between the two.

import { ACCOUNT_ACTIONS, PROJECT_ACTIONS } from './actions';

export type AccountRole = 'owner' | 'admin' | 'member';
export type ProjectRole = 'manager' | 'editor' | 'viewer';

// ─── Account roles ─────────────────────────────────────────────────────────

/** Owner-only actions: irreversible, billing-bound, or super-admin grants. */
const OWNER_ONLY: readonly string[] = [
  ACCOUNT_ACTIONS.ACCOUNT_DELETE,
  ACCOUNT_ACTIONS.BILLING_WRITE,
  ACCOUNT_ACTIONS.MEMBER_SUPER_ADMIN_GRANT,
];

/** Actions an admin gets on top of plain member. */
const ADMIN_EXTRAS: readonly string[] = [
  ACCOUNT_ACTIONS.ACCOUNT_WRITE,

  ACCOUNT_ACTIONS.MEMBER_INVITE,
  ACCOUNT_ACTIONS.MEMBER_UPDATE,
  ACCOUNT_ACTIONS.MEMBER_REMOVE,

  ACCOUNT_ACTIONS.GROUP_CREATE,
  ACCOUNT_ACTIONS.GROUP_UPDATE,
  ACCOUNT_ACTIONS.GROUP_DELETE,
  ACCOUNT_ACTIONS.GROUP_MEMBERS_MANAGE,

  ACCOUNT_ACTIONS.TOKEN_CREATE,
  ACCOUNT_ACTIONS.TOKEN_REVOKE,

  ACCOUNT_ACTIONS.AUDIT_READ,

  ACCOUNT_ACTIONS.PROJECT_CREATE,
];

/** Baseline a plain account member sees. No write surface; the engine
 *  still gates access by membership, so reads are scoped per-project. */
const MEMBER_BASELINE: readonly string[] = [
  ACCOUNT_ACTIONS.ACCOUNT_READ,
  ACCOUNT_ACTIONS.BILLING_READ,
  ACCOUNT_ACTIONS.MEMBER_READ,
  ACCOUNT_ACTIONS.GROUP_READ,
  ACCOUNT_ACTIONS.TOKEN_READ,
];

export const ACCOUNT_ROLE_PERMS: Record<AccountRole, ReadonlySet<string>> = {
  member: new Set<string>(MEMBER_BASELINE),
  admin: new Set<string>([...MEMBER_BASELINE, ...ADMIN_EXTRAS]),
  owner: new Set<string>([...MEMBER_BASELINE, ...ADMIN_EXTRAS, ...OWNER_ONLY]),
};

// ─── Project roles ─────────────────────────────────────────────────────────

/** Manager-only actions on a project: delete + member management. */
const MANAGER_ONLY: readonly string[] = [
  PROJECT_ACTIONS.PROJECT_DELETE,
  PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE,
];

/** Actions an editor gets on top of viewer. Triggers and sessions
 *  are part of "content" — editor manages them. */
const EDITOR_EXTRAS: readonly string[] = [
  PROJECT_ACTIONS.PROJECT_WRITE,
  PROJECT_ACTIONS.PROJECT_DEPLOY,

  PROJECT_ACTIONS.PROJECT_SESSION_START,
  PROJECT_ACTIONS.PROJECT_SESSION_EXEC,
  PROJECT_ACTIONS.PROJECT_SESSION_STOP,

  PROJECT_ACTIONS.PROJECT_TRIGGER_CREATE,
  PROJECT_ACTIONS.PROJECT_TRIGGER_UPDATE,
  PROJECT_ACTIONS.PROJECT_TRIGGER_DELETE,
  PROJECT_ACTIONS.PROJECT_TRIGGER_FIRE,
];

/** Read-only baseline. */
const VIEWER_BASELINE: readonly string[] = [
  PROJECT_ACTIONS.PROJECT_READ,
  PROJECT_ACTIONS.PROJECT_SESSION_READ,
  PROJECT_ACTIONS.PROJECT_MEMBERS_READ,
  PROJECT_ACTIONS.PROJECT_TRIGGER_READ,
];

export const PROJECT_ROLE_PERMS: Record<ProjectRole, ReadonlySet<string>> = {
  viewer: new Set<string>(VIEWER_BASELINE),
  editor: new Set<string>([...VIEWER_BASELINE, ...EDITOR_EXTRAS]),
  manager: new Set<string>([...VIEWER_BASELINE, ...EDITOR_EXTRAS, ...MANAGER_ONLY]),
};

// ─── Role ranking helpers ──────────────────────────────────────────────────

const PROJECT_ROLE_RANK: Record<ProjectRole, number> = {
  viewer: 1,
  editor: 2,
  manager: 3,
};

/** Return the higher-ranked of two project roles. Used when a user's
 *  effective project role comes from multiple sources (direct membership
 *  + several group grants) — they get the strongest of the bunch. */
export function maxProjectRole(a: ProjectRole, b: ProjectRole): ProjectRole {
  return PROJECT_ROLE_RANK[a] >= PROJECT_ROLE_RANK[b] ? a : b;
}

/** Owner/admin get implicit Manager on every project in their account.
 *  Member does not — they only see projects they've been added to. */
export function implicitProjectRoleForAccount(accountRole: AccountRole): ProjectRole | null {
  return accountRole === 'owner' || accountRole === 'admin' ? 'manager' : null;
}

// ─── Permission probes ─────────────────────────────────────────────────────

/** Does the account role grant this action? */
export function accountRoleAllows(role: AccountRole, action: string): boolean {
  return ACCOUNT_ROLE_PERMS[role].has(action);
}

/** Does the project role grant this action? */
export function projectRoleAllows(role: ProjectRole, action: string): boolean {
  return PROJECT_ROLE_PERMS[role].has(action);
}
