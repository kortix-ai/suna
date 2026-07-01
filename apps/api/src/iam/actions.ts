import type { Effect } from 'effect';
// Single source of truth for IAM permission strings.
//
// Convention: <resource>.<verb>[.subresource]. The resource prefix MUST match
// one of the iam_resource_type enum values, because the engine uses the prefix
// to know which scope_type a policy needs to grant the action.
//
// Secrets / env-vars are intentionally absent — handled separately later.

export const RESOURCE_TYPES = [
  'account',
  'project',
  'sandbox',
  'trigger',
  'channel',
  'member',
  'group',
] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

// ─── Account-scoped actions ────────────────────────────────────────────────
// Always granted via a policy with scope_type='account' (the Everything scope).

export const ACCOUNT_ACTIONS = {
  ACCOUNT_READ: 'account.read',
  ACCOUNT_WRITE: 'account.write',
  ACCOUNT_DELETE: 'account.delete',

  BILLING_READ: 'billing.read',
  BILLING_WRITE: 'billing.write',

  AUDIT_READ: 'audit.read',

  MEMBER_READ: 'member.read',
  MEMBER_INVITE: 'member.invite',
  MEMBER_UPDATE: 'member.update',
  MEMBER_REMOVE: 'member.remove',
  MEMBER_SUPER_ADMIN_GRANT: 'member.super_admin.grant',

  GROUP_READ: 'group.read',
  GROUP_CREATE: 'group.create',
  GROUP_UPDATE: 'group.update',
  GROUP_DELETE: 'group.delete',
  GROUP_MEMBERS_MANAGE: 'group.members.manage',

  POLICY_READ: 'policy.read',
  POLICY_CREATE: 'policy.create',
  POLICY_DELETE: 'policy.delete',

  ROLE_READ: 'role.read',
  ROLE_CREATE: 'role.create',
  ROLE_UPDATE: 'role.update',
  ROLE_DELETE: 'role.delete',

  TOKEN_READ: 'token.read',
  TOKEN_CREATE: 'token.create',
  TOKEN_REVOKE: 'token.revoke',


  // "Create a brand-new project" must live at account scope (the project
  // doesn't exist yet to scope to).
  PROJECT_CREATE: 'project.create',
} as const;

// ─── Project-scoped actions ────────────────────────────────────────────────
// Can be granted at scope_type='project' (a specific project) OR at
// scope_type='account' (every project in the account).

export const PROJECT_ACTIONS = {
  PROJECT_READ: 'project.read',
  PROJECT_WRITE: 'project.write',
  PROJECT_DELETE: 'project.delete',
  PROJECT_DEPLOY: 'project.deploy',

  // Change requests. Distinct from write/deploy so an agent can be granted
  // "open a CR" WITHOUT "merge it to the base branch" — merge is the canonical
  // destructive action (it lands code on main), and stays human/explicit.
  PROJECT_CR_OPEN: 'project.cr.open',
  PROJECT_CR_MERGE: 'project.cr.merge',

  PROJECT_SESSION_READ: 'project.session.read',
  PROJECT_SESSION_START: 'project.session.start',
  PROJECT_SESSION_EXEC: 'project.session.exec',
  PROJECT_SESSION_STOP: 'project.session.stop',

  PROJECT_MEMBERS_READ: 'project.members.read',
  PROJECT_MEMBERS_MANAGE: 'project.members.manage',

  PROJECT_TRIGGER_READ: 'project.trigger.read',
  PROJECT_TRIGGER_CREATE: 'project.trigger.create',
  PROJECT_TRIGGER_UPDATE: 'project.trigger.update',
  PROJECT_TRIGGER_DELETE: 'project.trigger.delete',
  PROJECT_TRIGGER_FIRE: 'project.trigger.fire',

  PROJECT_GATEWAY_LOGS_READ: 'project.gateway.logs.read',
  PROJECT_GATEWAY_SPEND_READ: 'project.gateway.spend.read',
  PROJECT_GATEWAY_ROUTING_EDIT: 'project.gateway.routing.edit',
  PROJECT_GATEWAY_BUDGET_SET: 'project.gateway.budget.set',
  PROJECT_GATEWAY_KEYS_MANAGE: 'project.gateway.keys.manage',

  // ── Per-capability leaf actions (IAM v1) ────────────────────────────────
  // Each project feature gets its own read/write leaf so a custom role can
  // DEACTIVATE one capability (omit the leaf) without losing the rest. Until a
  // route is migrated to assert these, it keeps gating on project.read/write,
  // so adding them is additive: every write leaf is also seeded into the Editor
  // built-in role and every read leaf into the User floor role (see
  // role-perms.ts), so no existing editor/user loses a capability. All resolve to 'project' scope
  // (prefix = 'project') via resourceTypeForAction.
  PROJECT_AGENT_READ: 'project.agent.read',
  PROJECT_AGENT_WRITE: 'project.agent.write',
  PROJECT_SKILL_READ: 'project.skill.read',
  PROJECT_SKILL_WRITE: 'project.skill.write',
  PROJECT_COMMAND_READ: 'project.command.read',
  PROJECT_COMMAND_WRITE: 'project.command.write',
  PROJECT_SCHEDULE_READ: 'project.schedule.read',
  PROJECT_SCHEDULE_WRITE: 'project.schedule.write',
  PROJECT_WEBHOOK_READ: 'project.webhook.read',
  PROJECT_WEBHOOK_WRITE: 'project.webhook.write',
  PROJECT_FILE_READ: 'project.file.read',
  PROJECT_FILE_WRITE: 'project.file.write',
  PROJECT_CUSTOMIZE_READ: 'project.customize.read',
  PROJECT_CUSTOMIZE_WRITE: 'project.customize.write',
  PROJECT_GITOPS_READ: 'project.gitops.read',
  PROJECT_GITOPS_PUSH: 'project.gitops.push',
  PROJECT_GITOPS_MERGE: 'project.gitops.merge',
  PROJECT_SECRET_READ: 'project.secret.read',
  PROJECT_SECRET_WRITE: 'project.secret.write',
  PROJECT_CONNECTOR_READ: 'project.connector.read',
  PROJECT_CONNECTOR_WRITE: 'project.connector.write',
} as const;

// ─── Trigger-scoped actions (when scoped to an individual trigger) ─────────

export const TRIGGER_ACTIONS = {
  TRIGGER_READ: 'trigger.read',
  TRIGGER_UPDATE: 'trigger.update',
  TRIGGER_DELETE: 'trigger.delete',
  TRIGGER_FIRE: 'trigger.fire',
} as const;

// ─── Channel-scoped actions ────────────────────────────────────────────────

export const CHANNEL_ACTIONS = {
  CHANNEL_READ: 'channel.read',
  CHANNEL_CONNECT: 'channel.connect',
  CHANNEL_SEND: 'channel.send',
  CHANNEL_DISCONNECT: 'channel.disconnect',
} as const;

// ─── Aggregate type for all valid action strings ───────────────────────────

export const ALL_ACTIONS = {
  ...ACCOUNT_ACTIONS,
  ...PROJECT_ACTIONS,
  ...TRIGGER_ACTIONS,
  ...CHANNEL_ACTIONS,
} as const;

export type Action = (typeof ALL_ACTIONS)[keyof typeof ALL_ACTIONS];

// Set of every valid action string. Used to validate custom-role action
// lists at the API boundary — unknown strings are rejected so a typo can't
// create a role that grants nothing useful.
export const VALID_ACTIONS: ReadonlySet<string> = new Set([
  ...Object.values(ACCOUNT_ACTIONS),
  ...Object.values(PROJECT_ACTIONS),
  ...Object.values(TRIGGER_ACTIONS),
  ...Object.values(CHANNEL_ACTIONS),
]);

/**
 * Catalog grouped for the UI's action picker. Each item carries a human
 * label so the frontend doesn't have to title-case dotted strings.
 */
export interface ActionCatalogEntry {
  action: string;
  label: string;
  resourceType: ResourceType;
}

function label(action: string): string {
  return action
    .split('.')
    .map((part) => part[0]?.toUpperCase() + part.slice(1).replace(/_/g, ' '))
    .join(' · ');
}

export const ACTION_CATALOG: ActionCatalogEntry[] = [
  ...Object.values(ACCOUNT_ACTIONS).map((a) => ({
    action: a,
    label: label(a),
    resourceType: resourceTypeForAction(a),
  })),
  ...Object.values(PROJECT_ACTIONS).map((a) => ({
    action: a,
    label: label(a),
    resourceType: resourceTypeForAction(a),
  })),
  ...Object.values(TRIGGER_ACTIONS).map((a) => ({
    action: a,
    label: label(a),
    resourceType: resourceTypeForAction(a),
  })),
  ...Object.values(CHANNEL_ACTIONS).map((a) => ({
    action: a,
    label: label(a),
    resourceType: resourceTypeForAction(a),
  })),
];

/**
 * Returns the resource_type the engine should match against for a given
 * action. Derived from the dotted prefix.
 *
 * project.session.exec   → 'project'
 * sandbox.start          → 'sandbox'
 * member.invite          → 'account'  (account-level member admin)
 */
export function resourceTypeForAction(action: string): ResourceType {
  const prefix = action.split('.', 1)[0] as ResourceType;
  // Member / group / role / policy / token / billing / audit / account_*
  // are all account-scoped admin actions.
  if (
    prefix === 'account' ||
    action.startsWith('member.') ||
    action.startsWith('group.') ||
    action.startsWith('role.') ||
    action.startsWith('policy.') ||
    action.startsWith('token.') ||
    action.startsWith('billing.') ||
    action.startsWith('audit.') ||
    action === 'project.create'
  ) {
    return 'account';
  }
  // Otherwise the prefix is itself a resource type.
  if ((RESOURCE_TYPES as readonly string[]).includes(prefix)) {
    return prefix;
  }
  // Defensive fallback — unknown action always requires account scope.
  return 'account';
}
