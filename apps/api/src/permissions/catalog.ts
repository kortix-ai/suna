export type ScopeGroup =
  | 'sandbox'
  | 'members'
  | 'projects'
  | 'billing';

export interface ScopeMeta {
  label: string;
  description: string;
  group: ScopeGroup;
}

export const SCOPE_CATALOG = {
  'sandbox:use': {
    label: 'Use instance',
    description: 'Use the instance to run commands, edit files, and interact with running services.',
    group: 'sandbox',
  },
  'sandbox:upgrade': {
    label: 'Run instance updates',
    description: 'Apply Kortix platform updates to this instance.',
    group: 'sandbox',
  },

  'members:invite': {
    label: 'Invite teammates',
    description: 'Send invites to add new members, and revoke pending invites.',
    group: 'members',
  },
  'members:remove': {
    label: 'Remove teammates',
    description: "Revoke another member's access.",
    group: 'members',
  },
  'members:change_role': {
    label: 'Change roles',
    description: 'Promote or demote members between admin and member.',
    group: 'members',
  },
  'members:set_cap': {
    label: 'Set spending caps',
    description: "Limit how much a member can spend against the owner's wallet per billing cycle.",
    group: 'members',
  },

  'projects:create': {
    label: 'Create projects',
    description: 'Start new projects in this instance.',
    group: 'projects',
  },
  'projects:rename': {
    label: 'Rename projects',
    description: 'Change the display name of a project.',
    group: 'projects',
  },
  'projects:delete': {
    label: 'Delete projects',
    description: 'Permanently remove a project and all sessions inside it.',
    group: 'projects',
  },
  'projects:access.manage': {
    label: 'Manage project access',
    description: "Grant or revoke other members' access to specific projects.",
    group: 'projects',
  },

  'billing:manage': {
    label: 'Manage billing',
    description: 'Change plan, payment methods, cancel, or reactivate the subscription.',
    group: 'billing',
  },
} as const satisfies Record<string, ScopeMeta>;

export type Scope = keyof typeof SCOPE_CATALOG;
export const ALL_SCOPES = Object.keys(SCOPE_CATALOG) as Scope[];

export function isScope(value: string): value is Scope {
  return Object.prototype.hasOwnProperty.call(SCOPE_CATALOG, value);
}

export function scopesByGroup(): Record<ScopeGroup, Scope[]> {
  const out = {} as Record<ScopeGroup, Scope[]>;
  for (const scope of ALL_SCOPES) {
    const group = SCOPE_CATALOG[scope].group;
    (out[group] ??= []).push(scope);
  }
  return out;
}
