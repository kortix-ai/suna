// IAM V2 role → permissions mapping. Single source of truth, in code.
//
// Fixed roles, no DB-driven role table:
//   account: owner > admin > member
//   project: manager > member
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
// `editor` is REMOVED (owner decision, 2026-08-18). It sat between the two and
// held everything `manager` holds except member-management and project delete;
// the extra tier bought nothing. Every stored `editor` became `manager` (see
// the `project_role_editor_to_manager` data migration). The enum value stays in
// Postgres because a value cannot be dropped, but nothing writes it. Reads
// still FOLD it (`normalizeProjectRole` → `manager`) so a row written by a
// pre-removal replica during a rollout keeps working; WRITES reject it
// (`parseAssignableProjectRole` → null → 400), because silently upgrading a
// caller who asked for `editor` to full project control must be explicit.

import { ACCOUNT_ACTIONS, PROJECT_ACTIONS } from './actions';

export type AccountRole = 'owner' | 'admin' | 'member';
export type ProjectRole = 'manager' | 'member';

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

/** The irreversible / membership-bound half of manager. Kept as its own list
 *  because these are the leaves a custom project role must never be able to
 *  reach by accident. */
const MANAGER_ONLY: readonly string[] = [
  PROJECT_ACTIONS.PROJECT_DELETE,
  PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE,
  PROJECT_ACTIONS.PROJECT_GATEWAY_KEYS_MANAGE,
  PROJECT_ACTIONS.PROJECT_GATEWAY_OTEL_MANAGE,
  PROJECT_ACTIONS.PROJECT_SESSION_BINDINGS_WRITE,
  PROJECT_ACTIONS.PROJECT_CONNECTOR_CONNECTIONS_MANAGE,
];

/** Actions a manager gets on top of member. Editing the project and triggers
 *  are "customization" — that's what separates a
 *  manager from a member. Running sessions is NOT here: it's part of the
 *  member baseline (see below). (Was `EDITOR_EXTRAS` until the `editor` role
 *  was removed on 2026-08-18; manager already held every one of these, so the
 *  fold changed no permission.) */
const MANAGER_EXTRAS: readonly string[] = [
  PROJECT_ACTIONS.PROJECT_WRITE,
  PROJECT_ACTIONS.PROJECT_TRIGGER_CREATE,
  PROJECT_ACTIONS.PROJECT_TRIGGER_UPDATE,
  PROJECT_ACTIONS.PROJECT_TRIGGER_DELETE,
  PROJECT_ACTIONS.PROJECT_TRIGGER_FIRE,

  PROJECT_ACTIONS.PROJECT_GATEWAY_BUDGET_SET,

  // Per-capability write leaves (IAM v1). Manager keeps every capability it has
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
  // customization, like triggers and gitops. Manager keeps exactly what it had
  // when these routes asserted project.customize.write.
  PROJECT_ACTIONS.PROJECT_APP_WRITE,
  PROJECT_ACTIONS.PROJECT_APP_DEPLOY,

  // Sensitive READS — moved out of the floor `member` role. A plain member can
  // read the project shell and its own sessions, but not browse the file tree,
  // view secret values, or reach ANY of the "Customize" surface (Connectors,
  // Skills, the customize hub itself). Manager retains all of it.
  //
  // project.agent.read is NOT in this list — see PROJECT_MEMBER_BASELINE.
  PROJECT_ACTIONS.PROJECT_FILE_READ,
  PROJECT_ACTIONS.PROJECT_SECRET_READ,
  PROJECT_ACTIONS.PROJECT_CONNECTOR_READ,
  PROJECT_ACTIONS.PROJECT_SKILL_READ,
  PROJECT_ACTIONS.PROJECT_CUSTOMIZE_READ,

  // Acting on a review item (approve / reject / answer) is a decision on agent
  // work — manager-tier, alongside gitops.
  PROJECT_ACTIONS.PROJECT_REVIEW_ACT,
];

/** Baseline for the floor project role. `member` is a read + RUN role: it can
 *  see the project shell, its sessions, and its member/trigger list, it can
 *  start/stop/fire, and it can run the AGENTS THAT HAVE BEEN GRANTED TO IT —
 *  but it cannot browse or manage Connectors or Skills, cannot read files or
 *  secret values, and cannot open the Customize surface at all
 *  (project.customize.read lives in MANAGER_EXTRAS).
 *
 *  Connectors/Skills/Customize are manager-tier by default. Agents are
 *  different, and deliberately so: the leaf is here and the per-agent grants do
 *  the scoping (deny-by-default — see PROJECT_AGENT_READ below). Access stays
 *  opt-in, it is just expressed through grants instead of the role.
 *
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
  // project.secret.read, project.connector.read, project.skill.read, and
  // project.customize.read are DELIBERATELY NOT here — they all moved to
  // MANAGER_EXTRAS. A floor `member` gets NO default access to
  // Connectors/Skills/Customize; that whole surface is manager-tier by design.
  //
  // project.agent.read IS here, and has to be, because a resource grant CANNOT
  // add a permission — the engine intersects grants with what the role already
  // allows (authorizeV2's per-resource fold runs only after the role check
  // passes). While this leaf sat in MANAGER_EXTRAS, the sentence "a member gets
  // an agent when an explicit grant names them" was unimplementable: granting a
  // member an agent left them 403 on `project.agent.read` anyway, so the whole
  // per-agent grant feature was inert for the exact role it exists to serve,
  // and the composer's agent list came back empty for every member.
  //
  // Holding the leaf is not blanket access. Agents are DENY-BY-DEFAULT for
  // member-tier callers (resource-grants.ts `isProjectResourceUsableByMember`):
  // the fold reduces "may interact with agents" down to "may interact with the
  // agents explicitly granted to me or my groups", and an unscoped agent is
  // closed to a member. So the leaf answers "at all?" and the grants answer
  // "which?" — which is what the design intended all along.
  //
  // It is the ONLY read leaf that can safely come back: the others still use
  // the older unscoped-is-open fold, where the leaf alone would mean everything.
  PROJECT_ACTIONS.PROJECT_AGENT_READ,
  PROJECT_ACTIONS.PROJECT_COMMAND_READ,
  PROJECT_ACTIONS.PROJECT_GITOPS_READ,
  // Kortix Apps: a member sees the Apps the App access policy shares with
  // them. The policy, not this leaf, decides which Apps that is.
  PROJECT_ACTIONS.PROJECT_APP_READ,

  // Review Center: the floor role can see the inbox and (via its agent) submit
  // outputs/decisions for review. Acting on them is manager-tier (MANAGER_EXTRAS).
  PROJECT_ACTIONS.PROJECT_REVIEW_READ,
  PROJECT_ACTIONS.PROJECT_REVIEW_SUBMIT,
];

/** What the floor `member` role gets on top of the read+run baseline: manually
 *  FIRE the project's triggers (operate the automations) — still no editing,
 *  config, deploy, gitops, members or secret write. This keeps the chain a
 *  clean superset: member ⊂ manager (MANAGER_EXTRAS also includes fire). */
const PROJECT_MEMBER_EXTRAS: readonly string[] = [PROJECT_ACTIONS.PROJECT_TRIGGER_FIRE];

export const PROJECT_ROLE_PERMS: Record<ProjectRole, ReadonlySet<string>> = {
  member: new Set<string>([...PROJECT_MEMBER_BASELINE, ...PROJECT_MEMBER_EXTRAS]),
  manager: new Set<string>([...PROJECT_MEMBER_BASELINE, ...MANAGER_EXTRAS, ...MANAGER_ONLY]),
};

// ─── Role ranking helpers ──────────────────────────────────────────────────

export const PROJECT_ROLE_RANK: Record<ProjectRole, number> = {
  member: 1,
  manager: 2,
};

/**
 * Coerce a STORED role value (DB column, legacy token claim, an old invite's
 * bootstrap grant) into a canonical ProjectRole. Every retired tier folds:
 * `user`/`viewer` → `member`, `editor` → `manager`. Reads must never fail on a
 * value the database can legitimately still hold — during the rollout window a
 * pre-removal replica can still write `editor`, and the enum value is
 * undroppable. Returns null for anything unrecognized, including non-string
 * input.
 *
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
 * `normalizeProjectRole` is lenient: `editor` is rejected, not folded.
 * Folding it would silently hand a caller who asked for the middle tier full
 * project control — including member management and delete. Making them say
 * `manager` keeps that an explicit act.
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
