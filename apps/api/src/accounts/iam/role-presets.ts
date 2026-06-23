// Pure helpers for the IAM v1 custom-roles surface: the built-in role presets
// (read-only reference + clone templates, incl. the "User" read+run tier) and
// the write-time action validator. No db/router imports → unit-testable.

import { ACTION_CATALOG, PROJECT_ACTIONS, VALID_ACTIONS } from '../../iam';
import { ACCOUNT_ROLE_PERMS, PROJECT_ROLE_PERMS } from '../../iam/role-perms';

/** The "User (read + run)" tier (Q4): read everything + start/run sessions +
 *  fire triggers; no editing, config, deploy, gitops, members or secret write. */
export const USER_PRESET_ACTIONS: readonly string[] = [
  ...PROJECT_ROLE_PERMS.viewer,
  PROJECT_ACTIONS.PROJECT_SESSION_START,
  PROJECT_ACTIONS.PROJECT_SESSION_EXEC,
  PROJECT_ACTIONS.PROJECT_SESSION_STOP,
  PROJECT_ACTIONS.PROJECT_TRIGGER_FIRE,
];

export interface BuiltinPreset {
  key: string;
  name: string;
  description: string;
  resourceType: 'account' | 'project';
  actions: readonly string[];
}

export const BUILTIN_PRESETS: readonly BuiltinPreset[] = [
  { key: 'manager', name: 'Manager', description: 'Full project control, including members and delete.', resourceType: 'project', actions: [...PROJECT_ROLE_PERMS.manager] },
  { key: 'editor', name: 'Editor', description: 'Create and edit project content, run sessions.', resourceType: 'project', actions: [...PROJECT_ROLE_PERMS.editor] },
  { key: 'user', name: 'User (read + run)', description: 'Read everything and start/run sessions — no editing or config.', resourceType: 'project', actions: [...USER_PRESET_ACTIONS] },
  { key: 'viewer', name: 'Viewer', description: 'Read-only access to the project.', resourceType: 'project', actions: [...PROJECT_ROLE_PERMS.viewer] },
  { key: 'owner', name: 'Owner', description: 'Full account control.', resourceType: 'account', actions: [...ACCOUNT_ROLE_PERMS.owner] },
  { key: 'admin', name: 'Admin', description: 'Manage members, groups, roles and tokens.', resourceType: 'account', actions: [...ACCOUNT_ROLE_PERMS.admin] },
  { key: 'member', name: 'Member', description: 'Baseline account membership.', resourceType: 'account', actions: [...ACCOUNT_ROLE_PERMS.member] },
];

export const BUILTIN_BY_ID: ReadonlyMap<string, BuiltinPreset> = new Map(
  BUILTIN_PRESETS.map((p) => [`builtin:${p.key}`, p]),
);

export const ACTION_CATALOG_WIRE = ACTION_CATALOG.map((e) => ({
  action: e.action,
  label: e.label,
  resource_type: e.resourceType,
}));

/** Validate + dedupe a custom role's action list against the known catalog.
 *  Rejects any string that isn't a real action so a typo can't mint a useless
 *  (or, worse, forward-incompatible) role. */
export function validateActions(
  actions: unknown,
): { ok: true; actions: string[] } | { ok: false; error: string } {
  if (!Array.isArray(actions)) return { ok: false, error: 'actions must be an array of permission strings' };
  const out: string[] = [];
  for (const a of actions) {
    if (typeof a !== 'string' || !VALID_ACTIONS.has(a)) {
      return { ok: false, error: `unknown action: ${String(a)}` };
    }
    if (!out.includes(a)) out.push(a);
  }
  return { ok: true, actions: out };
}
