/**
 * Workspace key scopes (design.md §3.2 C4a): what a key may do INSIDE its
 * creator's role.
 *
 *   full    NULL in `account_tokens.scopes`: the creator's whole role. Every key
 *           minted before 2026-11-06 is full.
 *   read    `{preset:'read'}`: every action whose name ends in `.read`, in either
 *           spelling (`project.session.read` = `workspace.session.read`). The
 *           preset is stored by name, so an action added later joins it.
 *   custom  `{permissions:[…]}`: exactly the listed actions, stored in the legacy
 *           spelling the catalog keeps.
 *
 * A scope only narrows. `authorize` evaluates the creator's CURRENT role in the
 * same call (`iam/authorize.ts` step 1c), so a key never exceeds the role its
 * creator holds now, whatever it held at mint.
 *
 * `project.read` (`workspace.read`) passes every scope: it is the gate every
 * workspace route opens with (`loadProjectForUser('read')`), and a key that
 * cannot read its own workspace record can do nothing at all. The route's own
 * leaf action is what the scope decides.
 *
 * A key whose scope holds only read actions is READ-ONLY by method as well:
 * the auth middleware refuses its non-GET/HEAD requests (`keyScopeMethodAllows`)
 * before any handler runs, so a write route that gates on `project.read` alone
 * cannot be reached with it.
 */
import type { StoredKeyScopes } from '@kortix/db';
import { isKnownAction, toLegacyAction, toWorkspaceAction } from './actions';

export type KeyScopes = StoredKeyScopes;
export type KeyScopeLabel = 'full' | 'read' | 'custom';

/** The gate every workspace route opens with; every scope passes it. */
const WORKSPACE_READ = 'project.read';

/** At most this many actions in a custom scope (the catalog has ~100). */
export const MAX_SCOPE_PERMISSIONS = 200;

/** A read action, in either spelling: its name ends in `.read`. */
export function isReadAction(action: string): boolean {
  return toLegacyAction(action).endsWith('.read');
}

/**
 * Normalize a stored value. A malformed value reads as an empty custom scope
 * (deny everything but the workspace read): a scope column that cannot be read
 * must never widen a key to full.
 */
export function readKeyScopes(raw: unknown): KeyScopes | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>;
    if (r.preset === 'read') return { preset: 'read' };
    if (Array.isArray(r.permissions)) {
      return { permissions: r.permissions.filter((p): p is string => typeof p === 'string').map(toLegacyAction) };
    }
  }
  return { permissions: [] };
}

/** May a key with `scopes` perform `action`? Null = full = yes. */
export function keyScopeAllows(scopes: KeyScopes | null, action: string): boolean {
  if (!scopes) return true;
  const legacy = toLegacyAction(action);
  if (legacy === WORKSPACE_READ) return true;
  if ('preset' in scopes) return isReadAction(legacy);
  return scopes.permissions.some((p) => toLegacyAction(p) === legacy);
}

/** True when every action the scope allows is a read action. */
export function keyScopeIsReadOnly(scopes: KeyScopes | null): boolean {
  if (!scopes) return false;
  if ('preset' in scopes) return true;
  return scopes.permissions.every(isReadAction);
}

/** A read-only key reaches only GET, HEAD and OPTIONS. */
export function keyScopeMethodAllows(scopes: KeyScopes | null, method: string): boolean {
  if (!keyScopeIsReadOnly(scopes)) return true;
  const m = method.toUpperCase();
  return m === 'GET' || m === 'HEAD' || m === 'OPTIONS';
}

/** Is `child` no wider than `parent`? A scoped key mints only keys inside its own scope. */
export function keyScopeWithin(child: KeyScopes | null, parent: KeyScopes | null): boolean {
  if (!parent) return true;
  if (!child) return false;
  if ('preset' in child) return 'preset' in parent;
  return child.permissions.every((p) => keyScopeAllows(parent, p));
}

export function keyScopeLabel(scopes: KeyScopes | null): KeyScopeLabel {
  if (!scopes) return 'full';
  return 'preset' in scopes ? 'read' : 'custom';
}

/** The wire fields of a key's scope, on every key list and mint response. */
export function keyScopeWire(scopes: KeyScopes | null): {
  scope: KeyScopeLabel;
  permissions: string[] | null;
  workspace_permissions: string[] | null;
} {
  const permissions = scopes && 'permissions' in scopes ? scopes.permissions : null;
  return {
    scope: keyScopeLabel(scopes),
    permissions,
    workspace_permissions: permissions ? permissions.map(toWorkspaceAction) : null,
  };
}

export type ParsedKeyScopes =
  | { ok: true; scopes: KeyScopes | null; explicit: boolean }
  | { ok: false; error: string; code: 'invalid_scopes' };

/**
 * Parse the `scopes` field of a mint request: `'full'`, `'read'`, or a list of
 * action names in either spelling. Absent = not chosen (`explicit: false`):
 * the caller decides the default (full, or the minting key's own scope).
 */
export function parseKeyScopesInput(raw: unknown): ParsedKeyScopes {
  if (raw === undefined || raw === null) return { ok: true, scopes: null, explicit: false };
  if (raw === 'full') return { ok: true, scopes: null, explicit: true };
  if (raw === 'read') return { ok: true, scopes: { preset: 'read' }, explicit: true };
  if (Array.isArray(raw)) {
    if (raw.length === 0) return { ok: false, code: 'invalid_scopes', error: 'scopes must list at least one permission' };
    if (raw.length > MAX_SCOPE_PERMISSIONS) {
      return { ok: false, code: 'invalid_scopes', error: `scopes lists at most ${MAX_SCOPE_PERMISSIONS} permissions` };
    }
    const unknown = raw.filter((p) => typeof p !== 'string' || !isKnownAction(p));
    if (unknown.length > 0) {
      return {
        ok: false,
        code: 'invalid_scopes',
        error: `Unknown permission ${unknown.map((p) => JSON.stringify(p)).join(', ')}. GET /v1/workspaces/<id>/iam/permissions lists them.`,
      };
    }
    const legacy = [...new Set((raw as string[]).map(toLegacyAction))].sort();
    return { ok: true, scopes: { permissions: legacy }, explicit: true };
  }
  return { ok: false, code: 'invalid_scopes', error: 'scopes must be "full", "read" or a list of permissions' };
}
