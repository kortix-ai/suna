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
} as const;

// ─── Sandbox-scoped actions ────────────────────────────────────────────────

export const SANDBOX_ACTIONS = {
  SANDBOX_READ: 'sandbox.read',
  SANDBOX_START: 'sandbox.start',
  SANDBOX_STOP: 'sandbox.stop',
  SANDBOX_EXEC: 'sandbox.exec',
  SANDBOX_SNAPSHOT: 'sandbox.snapshot',
  SANDBOX_DELETE: 'sandbox.delete',
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
  ...SANDBOX_ACTIONS,
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
  ...Object.values(SANDBOX_ACTIONS),
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
  ...Object.values(SANDBOX_ACTIONS).map((a) => ({
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
