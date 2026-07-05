// IAM V2 role → permissions mapping. Single source of truth, in code.
//
// Fixed roles, no DB-driven role table:
//   account: owner > admin > member
//   project: editor > member
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
//
// PROJECT ROLE COLLAPSE (3 → 2): `manager` was RETIRED as a project role.
// `editor` is now the top project role (its permission set, EDITOR_EXTRAS,
// is unchanged). The three former manager-only leaves — project.delete,
// project.members.manage, project.gateway.keys.manage — are no longer
// reachable through ANY project role (explicit, group-derived, or the
// account owner/admin's implicit top role). They now require ACCOUNT
// owner/admin authority instead: see ACCOUNT_ONLY_PROJECT_ACTIONS below,
// which is folded into ADMIN_EXTRAS and treated as account-scope by
// engine-v2's `scopeForActionV2`. `manager` also survives only as a
// deprecated input alias (`normalizeProjectRole` folds it into `editor`) —
// Postgres can't drop an enum value, so a stray old row/token/cache entry
// still resolves sanely. Nothing emits it.

import { ACCOUNT_ACTIONS, PROJECT_ACTIONS } from './actions';

export type AccountRole = 'owner' | 'admin' | 'member';
export type ProjectRole = 'editor' | 'member';

// ─── Project actions promoted to ACCOUNT authority ─────────────────────────

/**
 * The three former "manager-only" project actions: delete + member
 * management + gateway-key management. These are irreversible or
 * membership/credential-mutating enough that Marko moved them off the
 * (now 2-tier) project role ladder entirely — only an ACCOUNT owner/admin
 * may perform them, never a project role (built-in or custom). Exported so
 * engine-v2 can route them to account-scope and role-presets can bar them
 * from custom roles.
 */
export const ACCOUNT_ONLY_PROJECT_ACTIONS: readonly string[] = [
  PROJECT_ACTIONS.PROJECT_DELETE,
  PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE,
  PROJECT_ACTIONS.PROJECT_GATEWAY_KEYS_MANAGE,
];

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

  // Former manager-only project leaves, promoted to account authority (see
  // ACCOUNT_ONLY_PROJECT_ACTIONS above). Owner inherits these too (owner's set
  // is MEMBER_BASELINE + ADMIN_EXTRAS + OWNER_ONLY).
  ...ACCOUNT_ONLY_PROJECT_ACTIONS,
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

/** Actions an editor gets on top of member. Editing the project,
 *  deploying, and triggers are "customization" — that's what separates an
 *  editor from a member. Running sessions is NOT here: it's part of the
 *  member baseline (see below). Editor is now the TOP project role — it
 *  deliberately does NOT include ACCOUNT_ONLY_PROJECT_ACTIONS (delete,
 *  members.manage, gateway.keys.manage): those require account owner/admin. */
const EDITOR_EXTRAS: readonly string[] = [
  PROJECT_ACTIONS.PROJECT_WRITE,
  PROJECT_ACTIONS.PROJECT_DEPLOY,

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

  // Acting on a review item (approve / reject / answer) is a decision on agent
  // work — editor-tier, alongside gitops.
  PROJECT_ACTIONS.PROJECT_REVIEW_ACT,
];

/** Baseline for the floor project role. `member` is the base *usable* role:
 *  it can read everything AND start / run / stop sessions — i.e. actually use
 *  the agent and the chat. A role that can't open a session is useless, and
 *  this is the role new members get by default, so it has to be able to drive
 *  Kortix. What it CANNOT do is customize the project: edit settings, deploy,
 *  or create/delete triggers — those live in EDITOR_EXTRAS above (member/
 *  editor management + gateway keys live at ACCOUNT scope now, see
 *  ACCOUNT_ONLY_PROJECT_ACTIONS). Named PROJECT_MEMBER_* to avoid colliding
 *  with the account-role MEMBER_BASELINE above. */
const PROJECT_MEMBER_BASELINE: readonly string[] = [
  PROJECT_ACTIONS.PROJECT_READ,
  PROJECT_ACTIONS.PROJECT_SESSION_READ,
  PROJECT_ACTIONS.PROJECT_MEMBERS_READ,
  PROJECT_ACTIONS.PROJECT_TRIGGER_READ,

  PROJECT_ACTIONS.PROJECT_SESSION_START,
  PROJECT_ACTIONS.PROJECT_SESSION_STOP,

  PROJECT_ACTIONS.PROJECT_GATEWAY_LOGS_READ,
  PROJECT_ACTIONS.PROJECT_GATEWAY_SPEND_READ,

  // Per-capability read leaves (IAM v1). The floor role keeps everything it
  // can read today (these previously collapsed to project.read).
  PROJECT_ACTIONS.PROJECT_AGENT_READ,
  PROJECT_ACTIONS.PROJECT_SKILL_READ,
  PROJECT_ACTIONS.PROJECT_COMMAND_READ,
  PROJECT_ACTIONS.PROJECT_FILE_READ,
  PROJECT_ACTIONS.PROJECT_CUSTOMIZE_READ,
  PROJECT_ACTIONS.PROJECT_GITOPS_READ,
  PROJECT_ACTIONS.PROJECT_SECRET_READ,
  PROJECT_ACTIONS.PROJECT_CONNECTOR_READ,

  // Review Center: the floor role can see the inbox and (via its agent) submit
  // outputs/decisions for review. Acting on them is editor-tier (EDITOR_EXTRAS).
  PROJECT_ACTIONS.PROJECT_REVIEW_READ,
  PROJECT_ACTIONS.PROJECT_REVIEW_SUBMIT,
];

/** What the floor `member` role gets on top of the read+run baseline: manually
 *  FIRE the project's triggers (operate the automations) — still no editing,
 *  config, deploy, or gitops. This keeps the chain a clean superset:
 *  member ⊂ editor (editor's EDITOR_EXTRAS also includes fire). */
const PROJECT_MEMBER_EXTRAS: readonly string[] = [PROJECT_ACTIONS.PROJECT_TRIGGER_FIRE];

export const PROJECT_ROLE_PERMS: Record<ProjectRole, ReadonlySet<string>> = {
  member: new Set<string>([...PROJECT_MEMBER_BASELINE, ...PROJECT_MEMBER_EXTRAS]),
  editor: new Set<string>([...PROJECT_MEMBER_BASELINE, ...EDITOR_EXTRAS]),
};

// ─── Role ranking helpers ──────────────────────────────────────────────────

export const PROJECT_ROLE_RANK: Record<ProjectRole, number> = {
  member: 1,
  editor: 2,
};

/**
 * Coerce any raw role value (DB column, request body, legacy token) into a
 * canonical ProjectRole. The retired `user` and `viewer` tiers fold into
 * `member`; the retired `manager` tier (project-role collapse) folds into
 * `editor` — its former exclusive powers (delete / members.manage /
 * gateway.keys.manage) live at account scope now, so a stray old `manager`
 * row/token/cache entry resolves to the new top project role, not a
 * privilege it no longer carries. They can still arrive from old rows,
 * tokens, or clients, so we normalize rather than reject. Returns null for
 * anything unrecognized, including non-string input (untyped request bodies
 * included).
 */
export function normalizeProjectRole(raw: unknown): ProjectRole | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  if (v === 'viewer' || v === 'user') return 'member';
  if (v === 'manager') return 'editor';
  return v === 'editor' || v === 'member' ? v : null;
}

/** Return the higher-ranked of two project roles. Used when a user's
 *  effective project role comes from multiple sources (direct membership
 *  + several group grants) — they get the strongest of the bunch. */
export function maxProjectRole(a: ProjectRole, b: ProjectRole): ProjectRole {
  return PROJECT_ROLE_RANK[a] >= PROJECT_ROLE_RANK[b] ? a : b;
}

/** Owner/admin get implicit Editor (the top project role) on every project
 *  in their account. Member does not — they only see projects they've been
 *  added to. Owner/admin's authority over the three ACCOUNT_ONLY_PROJECT_ACTIONS
 *  (delete / members.manage / gateway.keys.manage) comes from their ACCOUNT
 *  role directly (see ADMIN_EXTRAS), not from this implicit project role. */
export function implicitProjectRoleForAccount(accountRole: AccountRole): ProjectRole | null {
  return accountRole === 'owner' || accountRole === 'admin' ? 'editor' : null;
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
