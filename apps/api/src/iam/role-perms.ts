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
// only as deprecated input aliases (see `normalizeWorkspaceRole`) — `user` was
// renamed in the enum, `viewer` is a dormant value Postgres can't drop.
// Nothing emits either.

import { ACCOUNT_ACTIONS, WORKSPACE_ACTIONS } from './actions';

export type AccountRole = 'owner' | 'admin' | 'member';
export type WorkspaceRole = 'manager' | 'editor' | 'member';

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

  ACCOUNT_ACTIONS.WORKSPACE_CREATE,
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

// ─── Workspace roles ─────────────────────────────────────────────────────────

/** Manager-only actions on a project: delete + member management. */
const MANAGER_ONLY: readonly string[] = [
  WORKSPACE_ACTIONS.WORKSPACE_DELETE,
  WORKSPACE_ACTIONS.WORKSPACE_MEMBERS_MANAGE,
  WORKSPACE_ACTIONS.WORKSPACE_GATEWAY_KEYS_MANAGE,
  WORKSPACE_ACTIONS.WORKSPACE_SESSION_BINDINGS_WRITE,
  WORKSPACE_ACTIONS.WORKSPACE_CONNECTOR_CONNECTIONS_MANAGE,
];

/** Actions an editor gets on top of member. Editing the project and triggers
 *  are "customization" — that's what separates an
 *  editor from a member. Running sessions is NOT here: it's part of the
 *  member baseline (see below). */
const EDITOR_EXTRAS: readonly string[] = [
  WORKSPACE_ACTIONS.WORKSPACE_WRITE,
  WORKSPACE_ACTIONS.WORKSPACE_TRIGGER_CREATE,
  WORKSPACE_ACTIONS.WORKSPACE_TRIGGER_UPDATE,
  WORKSPACE_ACTIONS.WORKSPACE_TRIGGER_DELETE,
  WORKSPACE_ACTIONS.WORKSPACE_TRIGGER_FIRE,

  WORKSPACE_ACTIONS.WORKSPACE_GATEWAY_BUDGET_SET,

  // Per-capability write leaves (IAM v1). Editor keeps every capability it has
  // today (all of these previously collapsed to project.write); a custom role
  // deactivates a capability by OMITTING its leaf, never by editing this set.
  WORKSPACE_ACTIONS.WORKSPACE_AGENT_WRITE,
  WORKSPACE_ACTIONS.WORKSPACE_SKILL_WRITE,
  WORKSPACE_ACTIONS.WORKSPACE_COMMAND_WRITE,
  WORKSPACE_ACTIONS.WORKSPACE_FILE_WRITE,
  WORKSPACE_ACTIONS.WORKSPACE_CUSTOMIZE_WRITE,
  WORKSPACE_ACTIONS.WORKSPACE_GITOPS_PUSH,
  WORKSPACE_ACTIONS.WORKSPACE_GITOPS_MERGE,
  WORKSPACE_ACTIONS.WORKSPACE_SECRET_WRITE,
  WORKSPACE_ACTIONS.WORKSPACE_CONNECTOR_WRITE,

  // Sensitive READS — moved out of the floor `member` role. A plain member can
  // use the project (run the agent/chat) but can't browse the file tree via the
  // files page or view secret values; editor+ retains both. Makes "project
  // access without files/secrets" expressible as the built-in `member` role.
  WORKSPACE_ACTIONS.WORKSPACE_FILE_READ,
  WORKSPACE_ACTIONS.WORKSPACE_SECRET_READ,

  // Acting on a review item (approve / reject / answer) is a decision on agent
  // work — editor-tier, alongside gitops.
  WORKSPACE_ACTIONS.WORKSPACE_REVIEW_ACT,
];

/** Baseline for the floor project role. `member` is the base *usable* role:
 *  it can read the project and start / run / stop sessions — i.e. actually use
 *  the agent and the chat — but NOT view secret values or browse the file tree
 *  (those moved to editor-tier). A role that can't open a session is useless,
 *  and this is the role new members get by default, so it has to be able to
 *  drive Kortix. What it CANNOT do is customize the project (edit settings,
 *  deploy, manage members, create/delete triggers) OR read files/secrets —
 *  those live in EDITOR_EXTRAS / MANAGER_ONLY above. Named WORKSPACE_MEMBER_* to
 *  avoid colliding with the account-role MEMBER_BASELINE above. */
const WORKSPACE_MEMBER_BASELINE: readonly string[] = [
  WORKSPACE_ACTIONS.WORKSPACE_READ,
  WORKSPACE_ACTIONS.WORKSPACE_SESSION_READ,
  WORKSPACE_ACTIONS.WORKSPACE_MEMBERS_READ,
  WORKSPACE_ACTIONS.WORKSPACE_TRIGGER_READ,

  WORKSPACE_ACTIONS.WORKSPACE_SESSION_START,
  WORKSPACE_ACTIONS.WORKSPACE_SESSION_STOP,

  WORKSPACE_ACTIONS.WORKSPACE_GATEWAY_LOGS_READ,
  WORKSPACE_ACTIONS.WORKSPACE_GATEWAY_SPEND_READ,

  // Per-capability read leaves (IAM v1). NOTE: project.file.read and
  // project.secret.read are DELIBERATELY NOT here — they moved to EDITOR_EXTRAS
  // so a floor `member` can run the agent/chat but can't browse the file tree or
  // view secret values (the sensitive reads are an editor concern). This is the
  // one place `member ⊂ editor` is a real capability difference on reads.
  WORKSPACE_ACTIONS.WORKSPACE_AGENT_READ,
  WORKSPACE_ACTIONS.WORKSPACE_SKILL_READ,
  WORKSPACE_ACTIONS.WORKSPACE_COMMAND_READ,
  WORKSPACE_ACTIONS.WORKSPACE_CUSTOMIZE_READ,
  WORKSPACE_ACTIONS.WORKSPACE_GITOPS_READ,
  WORKSPACE_ACTIONS.WORKSPACE_CONNECTOR_READ,

  // Review Center: the floor role can see the inbox and (via its agent) submit
  // outputs/decisions for review. Acting on them is editor-tier (EDITOR_EXTRAS).
  WORKSPACE_ACTIONS.WORKSPACE_REVIEW_READ,
  WORKSPACE_ACTIONS.WORKSPACE_REVIEW_SUBMIT,
];

/** What the floor `member` role gets on top of the read+run baseline: manually
 *  FIRE the project's triggers (operate the automations) — still no editing,
 *  config, deploy, gitops, members or secret write. This keeps the chain a
 *  clean superset: member ⊂ editor ⊂ manager (editor's EDITOR_EXTRAS also
 *  includes fire). */
const WORKSPACE_MEMBER_EXTRAS: readonly string[] = [WORKSPACE_ACTIONS.WORKSPACE_TRIGGER_FIRE];

export const WORKSPACE_ROLE_PERMS: Record<WorkspaceRole, ReadonlySet<string>> = {
  member: new Set<string>([...WORKSPACE_MEMBER_BASELINE, ...WORKSPACE_MEMBER_EXTRAS]),
  editor: new Set<string>([...WORKSPACE_MEMBER_BASELINE, ...EDITOR_EXTRAS]),
  manager: new Set<string>([...WORKSPACE_MEMBER_BASELINE, ...EDITOR_EXTRAS, ...MANAGER_ONLY]),
};

// ─── Role ranking helpers ──────────────────────────────────────────────────

export const WORKSPACE_ROLE_RANK: Record<WorkspaceRole, number> = {
  member: 1,
  editor: 2,
  manager: 3,
};

/**
 * Coerce any raw role value (DB column, request body, legacy token) into a
 * canonical WorkspaceRole. The retired `user` and `viewer` tiers fold into
 * `member` — they can still arrive from old rows, tokens, or clients, so we
 * normalize rather than reject. Returns null for anything unrecognized,
 * including non-string input (untyped request bodies included).
 */
export function normalizeWorkspaceRole(raw: unknown): WorkspaceRole | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  if (v === 'viewer' || v === 'user') return 'member';
  return v === 'manager' || v === 'editor' || v === 'member' ? v : null;
}

/** Return the higher-ranked of two project roles. Used when a user's
 *  effective project role comes from multiple sources (direct membership
 *  + several group grants) — they get the strongest of the bunch. */
export function maxWorkspaceRole(a: WorkspaceRole, b: WorkspaceRole): WorkspaceRole {
  return WORKSPACE_ROLE_RANK[a] >= WORKSPACE_ROLE_RANK[b] ? a : b;
}

/** Owner/admin get implicit Manager on every project in their account.
 *  Member does not — they only see projects they've been added to. */
export function implicitWorkspaceRoleForAccount(accountRole: AccountRole): WorkspaceRole | null {
  return accountRole === 'owner' || accountRole === 'admin' ? 'manager' : null;
}

// ─── Permission probes ─────────────────────────────────────────────────────

/** Does the account role grant this action? */
export function accountRoleAllows(role: AccountRole, action: string): boolean {
  return ACCOUNT_ROLE_PERMS[role].has(action);
}

/** Does the project role grant this action? */
export function projectRoleAllows(role: WorkspaceRole, action: string): boolean {
  return WORKSPACE_ROLE_PERMS[role].has(action);
}
