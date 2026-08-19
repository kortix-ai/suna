// Write-time validation for the custom-roles surface, plus the wire shape of
// the action catalog.
//
// WHAT LEFT WITH THE CUTOVER
//   BUILTIN_PRESETS / BUILTIN_BY_ID / USER_PRESET_ACTIONS — the five built-in
//     roles as code constants. They are rows now (`kortix.roles` +
//     `kortix.role_permissions`, seeded by 20260819015724479); read them with
//     `loadSystemRoles()`.
//   NON_DELEGABLE_ACTIONS — a hand-maintained Set with no FK, kept in step with
//     the catalog by a parity test. It is the `delegable` COLUMN on
//     `kortix.permissions` now, and `validateActions` reads it.
//
// `validateActions` is therefore async: it asks the catalog, which is memoized
// with a 60s TTL, so the common case is no query at all.

import { ACTION_CATALOG, loadPermissionCatalog } from '../../iam';

export const ACTION_CATALOG_WIRE = ACTION_CATALOG.map((e) => ({
  action: e.action,
  label: e.label,
  resource_type: e.resourceType,
}));

/**
 * Validate + dedupe a custom role's action list against the catalog.
 *
 * Rejects any string that is not a real action, so a typo cannot mint a useless
 * (or, worse, forward-incompatible) role. When `resourceType` is supplied it
 * also enforces:
 *
 *   (a) the privilege-escalation ceiling — no action with `delegable = false`.
 *       An account admin already holds role.create + policy.create, so a custom
 *       role able to carry owner-only or IAM-management powers would let that
 *       admin mint it, bind themselves, and climb above their own ceiling. Those
 *       powers stay exclusive to the built-in owner/admin roles, which are not
 *       user-editable. (project.members.manage / project.gateway.keys.manage are
 *       deliberately DELEGABLE: they are project-scoped, so a department lead
 *       managing their own project's members can only hand out project roles.)
 *
 *   (b) namespace integrity — an `account` role holds only account-scoped
 *       actions and a `project` role only project-scoped ones, so a "department"
 *       project role cannot smuggle account powers, or the reverse. The
 *       catalog's `scope_type` column is the classifier; `resourceTypeForAction`
 *       was a second, differently-shaped one.
 *
 * The delegability ceiling is enforced a second time at BIND time, in
 * `assignRole` — validating at create alone left every role authored before a
 * catalog change grandfathered in.
 */
export async function validateActions(
  actions: unknown,
  resourceType?: 'account' | 'project',
): Promise<{ ok: true; actions: string[] } | { ok: false; error: string }> {
  if (!Array.isArray(actions)) return { ok: false, error: 'actions must be an array of permission strings' };
  const catalog = await loadPermissionCatalog();
  const out: string[] = [];
  for (const a of actions) {
    if (typeof a !== 'string') return { ok: false, error: `unknown action: ${String(a)}` };
    const entry = catalog.byAction.get(a);
    if (!entry) return { ok: false, error: `unknown action: ${a}` };
    if (!entry.delegable) {
      return { ok: false, error: `action not allowed in a custom role (privilege escalation): ${a}` };
    }
    if (resourceType && entry.scopeType !== resourceType) {
      return { ok: false, error: `action ${a} is not a ${resourceType}-scoped permission` };
    }
    if (!out.includes(a)) out.push(a);
  }
  return { ok: true, actions: out };
}
