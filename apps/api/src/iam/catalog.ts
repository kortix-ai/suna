/**
 * The permission catalog and the role→permission expansion, read from the
 * database instead of from three code constants.
 *
 * REPLACES: `iam/actions.ts` (ACCOUNT_ACTIONS / PROJECT_ACTIONS / VALID_ACTIONS
 * / resourceTypeForAction), `iam/role-perms.ts` (ACCOUNT_ROLE_PERMS /
 * PROJECT_ROLE_PERMS / accountRoleAllows / projectRoleAllows /
 * implicitProjectRoleForAccount), `accounts/iam/role-presets.ts`
 * (NON_DELEGABLE_ACTIONS / BUILTIN_PRESETS) and `engine-v2.scopeForActionV2`.
 * Those stay live until the cutover; this module is what replaces them.
 *
 * Every read is memoized with a long TTL: the catalog and the six system roles
 * change only when a migration runs, so a 60s window costs one query per minute
 * per replica and removes them from the request path entirely.
 */
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { iamRoleActions, iamRoles, objectPolicies, permissions } from '@kortix/db';
import { db } from '../shared/db';
import { ttlMemo } from '../shared/ttl-memo';

/** How long a catalog/system-role read is reused. Structural data, not grants. */
const CATALOG_TTL_MS = (() => {
  const raw = Number(process.env.IAM_CATALOG_TTL_MS);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 60_000;
})();

export type ScopeType = 'account' | 'project';
export type ObjectType = 'agent' | 'skill' | 'secret' | 'app' | 'trigger' | 'subproject';

export interface PermissionEntry {
  action: string;
  scopeType: ScopeType;
  resourceType: string;
  delegable: boolean;
  description: string;
  /** UI grouping key. */
  area: string;
  /** 'view' | 'edit' | 'admin'. */
  level: string;
  /** DIRECT implications; the closure is the consumer's job. */
  implies: string[];
}

export interface SystemRole {
  roleId: string;
  key: string;
  scopeType: ScopeType;
  name: string;
  actions: ReadonlySet<string>;
}

interface Catalog {
  byAction: ReadonlyMap<string, PermissionEntry>;
  all: readonly PermissionEntry[];
}

const loadCatalogMemo = ttlMemo({
  ttlMs: CATALOG_TTL_MS,
  keyFn: () => 'catalog',
  loader: async (): Promise<Catalog> => {
    const rows = await db
      .select({
        action: permissions.action,
        scopeType: permissions.scopeType,
        resourceType: permissions.resourceType,
        delegable: permissions.delegable,
        description: permissions.description,
        area: permissions.area,
        level: permissions.level,
        implies: permissions.implies,
      })
      .from(permissions);
    const all = rows.map((r) => ({
      action: r.action,
      scopeType: r.scopeType as ScopeType,
      resourceType: r.resourceType,
      delegable: r.delegable,
      description: r.description,
      area: r.area,
      level: r.level,
      implies: (r.implies ?? []) as string[],
    }));
    return { byAction: new Map(all.map((p) => [p.action, p])), all };
  },
  // An empty catalog means the seed migration has not run. Never remember that:
  // the next request after the migration must see the real thing.
  shouldCache: (c) => c.all.length > 0,
});

export async function loadPermissionCatalog(): Promise<Catalog> {
  return loadCatalogMemo();
}

/**
 * The scope an action is granted at.
 *
 * The catalog column is the ONE classifier — it replaces both
 * `scopeForActionV2` (account|project) and `resourceTypeForAction` (7 buckets),
 * which disagreed in shape and were reported by different surfaces
 * (`/effective` returned the second while the engine decided on the first).
 *
 * The fallback exists for one reason: an action string that is NOT in the
 * catalog. Two families are deliberately absent — `project.cr.open` /
 * `project.cr.merge` (collapsed into the gitops leaves) and `trigger.*` (dead).
 * A route that still passes one must land on the same scope, and therefore the
 * same denial reason, as it does today. It is a compatibility shim for the P3
 * window, not a second classifier: an uncataloged action is granted by no role,
 * so it can only ever produce a denial.
 */
export function scopeForUncatalogedAction(action: string): ScopeType {
  if (action === 'project.create') return 'account';
  if (
    action.startsWith('account.') ||
    action.startsWith('billing.') ||
    action.startsWith('audit.') ||
    action.startsWith('member.') ||
    action.startsWith('group.') ||
    action.startsWith('role.') ||
    action.startsWith('policy.') ||
    action.startsWith('token.')
  ) {
    return 'account';
  }
  return 'project';
}

export async function scopeForAction(action: string): Promise<ScopeType> {
  const catalog = await loadPermissionCatalog();
  return catalog.byAction.get(action)?.scopeType ?? scopeForUncatalogedAction(action);
}

// ─── System roles ───────────────────────────────────────────────────────────

interface SystemRoles {
  /** Keyed `${scopeType}:${key}` — e.g. `account:owner`, `project:manager`. */
  byKey: ReadonlyMap<string, SystemRole>;
  byId: ReadonlyMap<string, SystemRole>;
}

const loadSystemRolesMemo = ttlMemo({
  ttlMs: CATALOG_TTL_MS,
  keyFn: () => 'system-roles',
  loader: async (): Promise<SystemRoles> => {
    const [roleRows, actionRows] = await Promise.all([
      db
        .select({
          roleId: iamRoles.roleId,
          key: iamRoles.key,
          scopeType: iamRoles.scopeType,
          name: iamRoles.name,
        })
        .from(iamRoles)
        .where(isNull(iamRoles.accountId)),
      db
        .select({ roleId: iamRoleActions.roleId, action: iamRoleActions.action })
        .from(iamRoleActions)
        .innerJoin(iamRoles, eq(iamRoles.roleId, iamRoleActions.roleId))
        .where(isNull(iamRoles.accountId)),
    ]);
    const actionsByRole = new Map<string, Set<string>>();
    for (const r of actionRows) {
      const set = actionsByRole.get(r.roleId);
      if (set) set.add(r.action);
      else actionsByRole.set(r.roleId, new Set([r.action]));
    }
    const byKey = new Map<string, SystemRole>();
    const byId = new Map<string, SystemRole>();
    for (const r of roleRows) {
      const role: SystemRole = {
        roleId: r.roleId,
        key: r.key,
        scopeType: r.scopeType as ScopeType,
        name: r.name,
        actions: actionsByRole.get(r.roleId) ?? new Set<string>(),
      };
      byKey.set(`${role.scopeType}:${role.key}`, role);
      byId.set(role.roleId, role);
    }
    return { byKey, byId };
  },
  shouldCache: (r) => r.byKey.size > 0,
});

export async function loadSystemRoles(): Promise<SystemRoles> {
  return loadSystemRolesMemo();
}

/**
 * Actions a CUSTOM role grants. Memoized per role id; a role's action set
 * changes only through `PUT /iam/roles/:id/permissions`, which busts it.
 */
const loadCustomRoleActionsMemo = ttlMemo({
  ttlMs: CATALOG_TTL_MS,
  keyFn: (roleId: string) => roleId,
  loader: async (roleId: string): Promise<ReadonlySet<string>> => {
    const rows = await db
      .select({ action: iamRoleActions.action })
      .from(iamRoleActions)
      .where(eq(iamRoleActions.roleId, roleId));
    return new Set(rows.map((r) => r.action));
  },
});

export function invalidateRoleActions(roleId: string): void {
  loadCustomRoleActionsMemo.invalidate(roleId);
}

export async function loadCustomRoleActions(roleId: string): Promise<ReadonlySet<string>> {
  return loadCustomRoleActionsMemo(roleId);
}

/** Every non-system role in an account, for the roles API and for `assignRole`. */
export async function loadAccountRoles(accountId: string): Promise<
  Array<{ roleId: string; key: string; name: string; scopeType: ScopeType }>
> {
  const rows = await db
    .select({
      roleId: iamRoles.roleId,
      key: iamRoles.key,
      name: iamRoles.name,
      scopeType: iamRoles.scopeType,
    })
    .from(iamRoles)
    .where(and(eq(iamRoles.accountId, accountId), isNotNull(iamRoles.accountId)));
  return rows.map((r) => ({ ...r, scopeType: r.scopeType as ScopeType }));
}

// ─── Object policies ────────────────────────────────────────────────────────

export type UnscopedDefault = 'open' | 'closed';

const loadObjectPoliciesMemo = ttlMemo({
  ttlMs: CATALOG_TTL_MS,
  keyFn: () => 'object-policies',
  loader: async (): Promise<ReadonlyMap<string, UnscopedDefault>> => {
    const rows = await db
      .select({
        objectType: objectPolicies.objectType,
        unscopedDefaultForMember: objectPolicies.unscopedDefaultForMember,
      })
      .from(objectPolicies);
    return new Map(rows.map((r) => [r.objectType, r.unscopedDefaultForMember as UnscopedDefault]));
  },
  shouldCache: (m) => m.size > 0,
});

/**
 * What an object with NO grant rows means for a member-tier caller.
 *
 * Unknown type falls back to `closed`, which is the fail-safe direction: a new
 * object type nobody has written a policy for must not be silently open.
 * `agent` is `closed` and every other seeded type is `open`, which reproduces
 * `isProjectResourceUsableByMember` exactly.
 */
export async function unscopedDefaultFor(objectType: string): Promise<UnscopedDefault> {
  const policies = await loadObjectPoliciesMemo();
  return policies.get(objectType) ?? 'closed';
}

/** Test hook: drop every structural memo. */
export function clearCatalogCaches(): void {
  loadCatalogMemo.clear();
  loadSystemRolesMemo.clear();
  loadCustomRoleActionsMemo.clear();
  loadObjectPoliciesMemo.clear();
}
