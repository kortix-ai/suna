// IAM V2 role → permissions mapping. Single source of truth, in code.
//
// Fixed roles, no DB-driven role table:
//   account: owner > admin > member
//   project: manager > editor > member
//
// `>` means "strict superset" within the same axis. Owner has everything
// admin has, admin has everything member has, etc. Per-role sets below
// are the *full* permission set (not the delta), so the engine just does
// a Set.has() — no inheritance walk at request time.
//
// `member` is the floor project role (read + run sessions + fire triggers).
// The old `user` and `viewer` tiers were folded into `member`; they survive
// only as deprecated input aliases (see `normalizeProjectRole`) — `user` was
// renamed in the enum, `viewer` is a dormant value Postgres can't drop.
// Nothing emits either.

import { ACCOUNT_ACTIONS, PROJECT_ACTIONS } from './actions';

export type AccountRole = 'owner' | 'admin' | 'member';
export type ProjectRole = 'manager' | 'editor' | 'member';

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

  // Custom roles + policies (IAM v1) — managing department roles and their
  // assignments is an admin/owner capability.
  ACCOUNT_ACTIONS.ROLE_READ,
  ACCOUNT_ACTIONS.ROLE_CREATE,
  ACCOUNT_ACTIONS.ROLE_UPDATE,
  ACCOUNT_ACTIONS.ROLE_DELETE,
  ACCOUNT_ACTIONS.POLICY_READ,
  ACCOUNT_ACTIONS.POLICY_CREATE,
  ACCOUNT_ACTIONS.POLICY_DELETE,

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
  PROJECT_ACTIONS.PROJECT_GATEWAY_KEYS_MANAGE,
  PROJECT_ACTIONS.PROJECT_SESSION_BINDINGS_WRITE,
  PROJECT_ACTIONS.PROJECT_CONNECTOR_CONNECTIONS_MANAGE,
];

/** Actions an editor gets on top of member. Editing the project and triggers
 *  are "customization" — that's what separates an
 *  editor from a member. Running sessions is NOT here: it's part of the
 *  member baseline (see below). */
const EDITOR_EXTRAS: readonly string[] = [
  PROJECT_ACTIONS.PROJECT_WRITE,
  PROJECT_ACTIONS.PROJECT_TRIGGER_CREATE,
  PROJECT_ACTIONS.PROJECT_TRIGGER_UPDATE,
  PROJECT_ACTIONS.PROJECT_TRIGGER_DELETE,
  PROJECT_ACTIONS.PROJECT_TRIGGER_FIRE,

  PROJECT_ACTIONS.PROJECT_GATEWAY_BUDGET_SET,

  // Per-capability write leaves (IAM v1). Editor keeps every capability it has
  // today (all of these previously collapsed to project.write); a custom role
  // deactivates a capability by OMITTING its leaf, never by editing this set.
  PROJECT_ACTIONS.PROJECT_AGENT_WRITE,
  PROJECT_ACTIONS.PROJECT_SKILL_WRITE,
  PROJECT_ACTIONS.PROJECT_COMMAND_WRITE,
  PROJECT_ACTIONS.PROJECT_FILE_WRITE,
  PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE,
  PROJECT_ACTIONS.PROJECT_GITOPS_PUSH,
  PROJECT_ACTIONS.PROJECT_GITOPS_MERGE,
  PROJECT_ACTIONS.PROJECT_SECRET_WRITE,
  PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE,

  // Kortix Apps: creating/resizing an App and shipping a version are
  // customization, like triggers and gitops. Editor keeps exactly what it had
  // when these routes asserted project.customize.write.
  PROJECT_ACTIONS.PROJECT_APP_WRITE,
  PROJECT_ACTIONS.PROJECT_APP_DEPLOY,

  // Sensitive READS — moved out of the floor `member` role. A plain member can
  // read the project shell and its own sessions, but not browse the file tree,
  // view secret values, or reach ANY of the "Customize" surface (Agents,
  // Connectors, Skills, the customize hub itself). Editor+ retains all of it.
  // Running an already-started/default session is unaffected — this only gates
  // BROWSING/LAUNCHING agents by name and the Customize UI (see
  // PROJECT_MEMBER_BASELINE below for the full rationale).
  PROJECT_ACTIONS.PROJECT_FILE_READ,
  PROJECT_ACTIONS.PROJECT_SECRET_READ,
  PROJECT_ACTIONS.PROJECT_AGENT_READ,
  PROJECT_ACTIONS.PROJECT_CONNECTOR_READ,
  PROJECT_ACTIONS.PROJECT_SKILL_READ,
  PROJECT_ACTIONS.PROJECT_CUSTOMIZE_READ,

  // Acting on a review item (approve / reject / answer) is a decision on agent
  // work — editor-tier, alongside gitops.
  PROJECT_ACTIONS.PROJECT_REVIEW_ACT,
];

/** Baseline for the floor project role. `member` is a READ-ONLY, no-Customize
 *  role: it can see the project shell, its sessions, and its member/trigger
 *  list, and it can start/stop/fire what it's already scoped to — but it
 *  CANNOT browse, launch-by-name, or manage Agents, Connectors, or Skills, and
 *  it cannot open the Customize surface at all (project.customize.read lives in
 *  EDITOR_EXTRAS now). Agents/Connectors/Skills/Customize are ALL editor-tier
 *  by default: a plain member gets none of them unless an explicit per-resource
 *  IAM v1 grant names them, or their role is bumped to editor/manager. This is
 *  deliberate — access is opt-in via role/scope, never blanket-on-for-everyone.
 *  Named PROJECT_MEMBER_* to avoid colliding with the account-role
 *  MEMBER_BASELINE above. */
const PROJECT_MEMBER_BASELINE: readonly string[] = [
  PROJECT_ACTIONS.PROJECT_READ,
  PROJECT_ACTIONS.PROJECT_SESSION_READ,
  PROJECT_ACTIONS.PROJECT_MEMBERS_READ,
  PROJECT_ACTIONS.PROJECT_TRIGGER_READ,

  PROJECT_ACTIONS.PROJECT_SESSION_START,
  PROJECT_ACTIONS.PROJECT_SESSION_STOP,

  PROJECT_ACTIONS.PROJECT_GATEWAY_LOGS_READ,
  PROJECT_ACTIONS.PROJECT_GATEWAY_SPEND_READ,

  // Per-capability read leaves (IAM v1). NOTE: project.file.read,
  // project.secret.read, project.agent.read, project.connector.read,
  // project.skill.read, and project.customize.read are DELIBERATELY NOT here —
  // they all moved to EDITOR_EXTRAS. A floor `member` gets NO default access to
  // Agents/Connectors/Skills/Customize; that whole surface is editor-tier
  // (or an explicit per-resource grant) by design.
  PROJECT_ACTIONS.PROJECT_COMMAND_READ,
  PROJECT_ACTIONS.PROJECT_GITOPS_READ,
  // Kortix Apps: a member sees the Apps the App access policy shares with
  // them. The policy, not this leaf, decides which Apps that is.
  PROJECT_ACTIONS.PROJECT_APP_READ,

  // Review Center: the floor role can see the inbox and (via its agent) submit
  // outputs/decisions for review. Acting on them is editor-tier (EDITOR_EXTRAS).
  PROJECT_ACTIONS.PROJECT_REVIEW_READ,
  PROJECT_ACTIONS.PROJECT_REVIEW_SUBMIT,
];

/** What the floor `member` role gets on top of the read+run baseline: manually
 *  FIRE the project's triggers (operate the automations) — still no editing,
 *  config, deploy, gitops, members or secret write. This keeps the chain a
 *  clean superset: member ⊂ editor ⊂ manager (editor's EDITOR_EXTRAS also
 *  includes fire). */
const PROJECT_MEMBER_EXTRAS: readonly string[] = [PROJECT_ACTIONS.PROJECT_TRIGGER_FIRE];

export const PROJECT_ROLE_PERMS: Record<ProjectRole, ReadonlySet<string>> = {
  member: new Set<string>([...PROJECT_MEMBER_BASELINE, ...PROJECT_MEMBER_EXTRAS]),
  editor: new Set<string>([...PROJECT_MEMBER_BASELINE, ...EDITOR_EXTRAS]),
  manager: new Set<string>([...PROJECT_MEMBER_BASELINE, ...EDITOR_EXTRAS, ...MANAGER_ONLY]),
};

// ─── Role ranking helpers ──────────────────────────────────────────────────

export const PROJECT_ROLE_RANK: Record<ProjectRole, number> = {
  member: 1,
  editor: 2,
  manager: 3,
};

/**
 * Coerce any raw role value (DB column, request body, legacy token) into a
 * canonical ProjectRole. The retired `user` and `viewer` tiers fold into
 * `member` — they can still arrive from old rows, tokens, or clients, so we
 * normalize rather than reject. Returns null for anything unrecognized,
 * including non-string input (untyped request bodies included).
 */
export function normalizeProjectRole(raw: unknown): ProjectRole | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  if (v === 'viewer' || v === 'user') return 'member';
  return v === 'manager' || v === 'editor' || v === 'member' ? v : null;
}

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
