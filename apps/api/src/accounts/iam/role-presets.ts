// Pure helpers for the IAM v1 custom-roles surface: the built-in role presets
// (read-only reference + clone templates, incl. the "Member" read+run tier) and
// the write-time action validator. No db/router imports → unit-testable.

import { ACCOUNT_ACTIONS, ACTION_CATALOG, PROJECT_ACTIONS, VALID_ACTIONS, resourceTypeForAction } from '../../iam';
import { ACCOUNT_ROLE_PERMS, PROJECT_ROLE_PERMS } from '../../iam/role-perms';

/** The "Member" floor tier: read everything + start/run sessions + fire
 *  triggers; no editing, config, deploy, gitops, members or secret write.
 *  (The project floor role now that `viewer` was folded into it.) */
export const USER_PRESET_ACTIONS: readonly string[] = [
  ...PROJECT_ROLE_PERMS.member,
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
  { key: 'user', name: 'Member (read + run)', description: 'Read, run sessions, and fire triggers — no editing or config. The project floor role.', resourceType: 'project', actions: [...USER_PRESET_ACTIONS] },
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

/**
 * Actions that may NEVER appear in a user-defined custom role.
 *
 * Granting any of these through a custom role is a privilege-escalation vector:
 * an account admin already holds role.create + policy.create, so if a custom
 * role could carry owner-only or IAM-management powers, the admin could mint
 * such a role, bind themselves (or their group) to it, and climb above their
 * own ceiling — becoming an owner in all but name. These powers stay exclusive
 * to the built-in owner/admin presets, which are not user-editable.
 *
 * Note: project.members.manage / project.gateway.keys.manage are intentionally
 * NOT here — they are project-scoped (a department lead managing their own
 * project's members can only hand out project roles, never account roles), and
 * the built-in Manager preset already carries them.
 */
export const NON_DELEGABLE_ACTIONS: ReadonlySet<string> = new Set<string>([
  // Owner-only: irreversible, billing-bound, or super-admin.
  ACCOUNT_ACTIONS.ACCOUNT_DELETE,
  ACCOUNT_ACTIONS.BILLING_WRITE,
  ACCOUNT_ACTIONS.MEMBER_SUPER_ADMIN_GRANT,
  // Membership mutation — re-parents who is admin/owner.
  ACCOUNT_ACTIONS.MEMBER_INVITE,
  ACCOUNT_ACTIONS.MEMBER_UPDATE,
  ACCOUNT_ACTIONS.MEMBER_REMOVE,
  // Group mutation — group grants are themselves an escalation channel.
  ACCOUNT_ACTIONS.GROUP_CREATE,
  ACCOUNT_ACTIONS.GROUP_UPDATE,
  ACCOUNT_ACTIONS.GROUP_DELETE,
  ACCOUNT_ACTIONS.GROUP_MEMBERS_MANAGE,
  // The IAM surface itself — whoever can write roles/policies defines
  // everyone's permissions.
  ACCOUNT_ACTIONS.ROLE_CREATE,
  ACCOUNT_ACTIONS.ROLE_UPDATE,
  ACCOUNT_ACTIONS.ROLE_DELETE,
  ACCOUNT_ACTIONS.POLICY_CREATE,
  ACCOUNT_ACTIONS.POLICY_DELETE,
  // Account-wide credential minting.
  ACCOUNT_ACTIONS.TOKEN_CREATE,
  ACCOUNT_ACTIONS.TOKEN_REVOKE,
]);

/** Validate + dedupe a custom role's action list against the known catalog.
 *  Rejects any string that isn't a real action so a typo can't mint a useless
 *  (or, worse, forward-incompatible) role. When `resourceType` is supplied it
 *  also enforces (a) the privilege-escalation ceiling — no NON_DELEGABLE
 *  actions — and (b) namespace integrity: an `account` role holds only
 *  account-scoped actions, a `project` role holds only project-scoped actions,
 *  so a "department" project role can't smuggle account powers (or vice-versa). */
export function validateActions(
  actions: unknown,
  resourceType?: 'account' | 'project',
): { ok: true; actions: string[] } | { ok: false; error: string } {
  if (!Array.isArray(actions)) return { ok: false, error: 'actions must be an array of permission strings' };
  const out: string[] = [];
  for (const a of actions) {
    if (typeof a !== 'string' || !VALID_ACTIONS.has(a)) {
      return { ok: false, error: `unknown action: ${String(a)}` };
    }
    if (NON_DELEGABLE_ACTIONS.has(a)) {
      return { ok: false, error: `action not allowed in a custom role (privilege escalation): ${a}` };
    }
    if (resourceType) {
      // resourceTypeForAction returns the engine bucket: account-scoped admin
      // actions → 'account'; everything else (project/channel/trigger/sandbox)
      // → a non-account resource type. Custom roles only have two scope types,
      // so collapse non-account into 'project'.
      const bucket = resourceTypeForAction(a) === 'account' ? 'account' : 'project';
      if (bucket !== resourceType) {
        return { ok: false, error: `action ${a} is not a ${resourceType}-scoped permission` };
      }
    }
    if (!out.includes(a)) out.push(a);
  }
  return { ok: true, actions: out };
}
