/**
 * THE read side of the canonical model.
 *
 * `iam/authorize.ts` answers "may this principal do X". This module answers the
 * OTHER question every access screen asks: "who holds what, and how did they get
 * it". Both read exactly one grant store — `kortix.role_assignments` — so the
 * Members page can no longer disagree with the gate that runs a moment later.
 *
 * REPLACES the six hand-rolled queries the read models used to run:
 *   account_members.account_role   -> accountRoleMap / accountRoleFor
 *   project_members                -> projectRoleGrants
 *   project_group_grants           -> groupProjectGrants
 *   iam_policies (+ iam_roles)     -> customRoleBindings
 *   iam_resource_grants            -> objectGrantRows
 *   the four copies of the max-role fold -> foldProjectAccess
 *
 * WIRE COMPATIBILITY. Every projection below is shaped like the legacy row it
 * replaces, field for field, because the responses built from them are consumed
 * by a web app that ships independently of this API. `policy_id` and `grant_id`
 * become the ASSIGNMENT id — the same uuid the canonical DELETE route takes —
 * and the legacy DELETE routes accept either id (see accounts/iam/custom-roles.ts
 * and projects/routes/resource-grants.ts), so a client holding one from either
 * era can still revoke it.
 *
 * The legacy principal vocabulary is preserved on the wire too: `member` for a
 * user and `token` for a service account. The canonical names (`user`,
 * `service_account`) are what the tables and the new /iam/assignments surface
 * speak; translating at the serializer boundary is what keeps the old routes
 * byte-compatible while the store underneath is singular.
 */
import { and, eq, gt, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { iamRoles, roleAssignments } from '@kortix/db';
import { db } from '../shared/db';
import type { ScopeType } from './catalog';

// ─── Vocabulary ─────────────────────────────────────────────────────────────

export type AccountRoleKey = 'owner' | 'admin' | 'member';
export type ProjectRoleKey = 'manager' | 'member';

/** The legacy wire name for a principal kind. */
export type LegacyPrincipalType = 'member' | 'group' | 'token';

const ACCOUNT_ROLE_RANK: Record<AccountRoleKey, number> = { owner: 3, admin: 2, member: 1 };
const PROJECT_ROLE_RANK: Record<ProjectRoleKey, number> = { manager: 2, member: 1 };

/** The object-grant marker role. It carries no permissions; it exists so an
 *  object assignment has a role to point at. Never a project tier. */
const OBJECT_MARKER_ROLE_KEY = 'agent-user';

export function isAccountManagerRole(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

function canonicalToLegacyPrincipal(type: string): LegacyPrincipalType | null {
  if (type === 'user') return 'member';
  if (type === 'group') return 'group';
  if (type === 'service_account') return 'token';
  return null;
}

export function legacyToCanonicalPrincipal(type: string): 'user' | 'group' | 'service_account' | null {
  if (type === 'member') return 'user';
  if (type === 'group') return 'group';
  if (type === 'token') return 'service_account';
  return null;
}

// ─── The one query shape ────────────────────────────────────────────────────

/** Live rows only, exactly as the engine sees them: an expired assignment does
 *  not exist. `now()` is evaluated by Postgres, never by the API clock. */
function live() {
  return or(isNull(roleAssignments.expiresAt), gt(roleAssignments.expiresAt, sql`now()`))!;
}

const SELECTION = {
  assignmentId: roleAssignments.assignmentId,
  accountId: roleAssignments.accountId,
  principalType: roleAssignments.principalType,
  principalId: roleAssignments.principalId,
  roleId: roleAssignments.roleId,
  roleKey: iamRoles.key,
  roleName: iamRoles.name,
  roleAccountId: iamRoles.accountId,
  roleScopeType: iamRoles.scopeType,
  scopeType: roleAssignments.scopeType,
  scopeId: roleAssignments.scopeId,
  objectType: roleAssignments.objectType,
  objectId: roleAssignments.objectId,
  expiresAt: roleAssignments.expiresAt,
  grantedBy: roleAssignments.grantedBy,
  source: roleAssignments.source,
  createdAt: roleAssignments.createdAt,
  updatedAt: roleAssignments.updatedAt,
} as const;

type RawRow = {
  [K in keyof typeof SELECTION]: K extends 'expiresAt'
    ? Date | null
    : K extends 'createdAt' | 'updatedAt'
      ? Date
      : K extends 'roleAccountId' | 'scopeId' | 'objectType' | 'objectId' | 'grantedBy'
        ? string | null
        : string;
};

function baseQuery(where: ReturnType<typeof and>) {
  return db
    .select(SELECTION)
    .from(roleAssignments)
    .innerJoin(iamRoles, eq(iamRoles.roleId, roleAssignments.roleId))
    .where(where) as unknown as Promise<RawRow[]>;
}

// ─── 1. Account roles (was account_members.account_role) ────────────────────

/**
 * userId -> their account role, folded to the strongest when more than one
 * system account role is assigned.
 *
 * The legacy column could hold exactly one value, so the fold is new — and it is
 * the same `accountRoleRank` fold `authorize()` runs, which is the point: the
 * label a screen renders and the verdict a gate returns now come from one rule.
 */
export async function accountRoleMap(accountId: string): Promise<Map<string, AccountRoleKey>> {
  const rows = await baseQuery(
    and(
      eq(roleAssignments.accountId, accountId),
      eq(roleAssignments.scopeType, 'account'),
      eq(roleAssignments.principalType, 'user'),
      isNull(iamRoles.accountId),
      isNull(roleAssignments.objectType),
      live(),
    ),
  );
  const out = new Map<string, AccountRoleKey>();
  for (const r of rows) {
    const key = r.roleKey as AccountRoleKey;
    if (!ACCOUNT_ROLE_RANK[key]) continue;
    const held = out.get(r.principalId);
    if (!held || ACCOUNT_ROLE_RANK[key] > ACCOUNT_ROLE_RANK[held]) out.set(r.principalId, key);
  }
  return out;
}

/**
 * accountId -> this user's account role, across EVERY account they belong to.
 *
 * One query for the account switcher, which used to read the role straight off
 * the `account_members` join and would therefore label an account with a role
 * the engine does not agree with.
 */
export async function accountRolesForUser(userId: string): Promise<Map<string, AccountRoleKey>> {
  const rows = await baseQuery(
    and(
      eq(roleAssignments.scopeType, 'account'),
      eq(roleAssignments.principalType, 'user'),
      eq(roleAssignments.principalId, userId),
      isNull(iamRoles.accountId),
      isNull(roleAssignments.objectType),
      live(),
    ),
  );
  const out = new Map<string, AccountRoleKey>();
  for (const r of rows) {
    const key = r.roleKey as AccountRoleKey;
    if (!ACCOUNT_ROLE_RANK[key]) continue;
    const held = out.get(r.accountId);
    if (!held || ACCOUNT_ROLE_RANK[key] > ACCOUNT_ROLE_RANK[held]) out.set(r.accountId, key);
  }
  return out;
}

export async function accountRoleFor(accountId: string, userId: string): Promise<AccountRoleKey | null> {
  const rows = await baseQuery(
    and(
      eq(roleAssignments.accountId, accountId),
      eq(roleAssignments.scopeType, 'account'),
      eq(roleAssignments.principalType, 'user'),
      eq(roleAssignments.principalId, userId),
      isNull(iamRoles.accountId),
      isNull(roleAssignments.objectType),
      live(),
    ),
  );
  let best: AccountRoleKey | null = null;
  for (const r of rows) {
    const key = r.roleKey as AccountRoleKey;
    if (!ACCOUNT_ROLE_RANK[key]) continue;
    if (!best || ACCOUNT_ROLE_RANK[key] > ACCOUNT_ROLE_RANK[best]) best = key;
  }
  return best;
}

/** Live account owners, for the last-owner guards that still live in routes. */
export async function countAccountOwners(accountId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(distinct ${roleAssignments.principalId})::int` })
    .from(roleAssignments)
    .innerJoin(iamRoles, eq(iamRoles.roleId, roleAssignments.roleId))
    .where(
      and(
        eq(roleAssignments.accountId, accountId),
        eq(roleAssignments.scopeType, 'account'),
        eq(roleAssignments.principalType, 'user'),
        isNull(iamRoles.accountId),
        eq(iamRoles.key, 'owner'),
        live(),
      ),
    );
  return Number(row?.n ?? 0);
}

// ─── 2. Direct project roles (was project_members) ──────────────────────────

export interface ProjectRoleGrant {
  assignmentId: string;
  accountId: string;
  projectId: string;
  userId: string;
  projectRole: ProjectRoleKey;
  grantedBy: string | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Direct (user, project) system-role assignments — the `project_members` rows.
 * Object assignments and the `agent-user` marker are excluded: a member handed
 * ONE agent is not a project member, and reading them as one is exactly the
 * silent tier promotion the marker role exists to prevent.
 */
export async function projectRoleGrants(filter: {
  accountId: string;
  projectId?: string;
  userId?: string;
}): Promise<ProjectRoleGrant[]> {
  const clauses = [
    eq(roleAssignments.accountId, filter.accountId),
    eq(roleAssignments.scopeType, 'project'),
    eq(roleAssignments.principalType, 'user'),
    isNull(roleAssignments.objectType),
    isNull(iamRoles.accountId),
    ne(iamRoles.key, OBJECT_MARKER_ROLE_KEY),
    live(),
  ];
  if (filter.projectId) clauses.push(eq(roleAssignments.scopeId, filter.projectId));
  if (filter.userId) clauses.push(eq(roleAssignments.principalId, filter.userId));
  const rows = await baseQuery(and(...clauses));
  return foldStrongestPerKey(rows, (r) => `${r.principalId}|${r.scopeId}`).map((r) => ({
    assignmentId: r.assignmentId,
    accountId: r.accountId,
    projectId: r.scopeId!,
    userId: r.principalId,
    projectRole: r.roleKey as ProjectRoleKey,
    grantedBy: r.grantedBy,
    expiresAt: r.expiresAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

/**
 * The strongest SYSTEM project role one user holds on one project, or null.
 *
 * The single-row form of `projectRoleGrants`, kept separate because it runs on
 * EVERY project-scoped request (`loadProjectForUser`) and must stay one indexed
 * lookup. No account id: a project id is globally unique.
 */
export async function projectRoleForUser(
  projectId: string,
  userId: string,
): Promise<ProjectRoleKey | null> {
  const rows = await baseQuery(
    and(
      eq(roleAssignments.scopeType, 'project'),
      eq(roleAssignments.scopeId, projectId),
      eq(roleAssignments.principalType, 'user'),
      eq(roleAssignments.principalId, userId),
      isNull(roleAssignments.objectType),
      isNull(iamRoles.accountId),
      ne(iamRoles.key, OBJECT_MARKER_ROLE_KEY),
      live(),
    ),
  );
  let best: ProjectRoleKey | null = null;
  for (const r of rows) {
    const key = r.roleKey as ProjectRoleKey;
    if (!PROJECT_ROLE_RANK[key]) continue;
    if (!best || PROJECT_ROLE_RANK[key] > PROJECT_ROLE_RANK[best]) best = key;
  }
  return best;
}

// ─── 3. Group project grants (was project_group_grants) ─────────────────────

export interface GroupProjectGrant {
  assignmentId: string;
  accountId: string;
  projectId: string;
  groupId: string;
  role: ProjectRoleKey;
  grantedBy: string | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export async function groupProjectGrants(filter: {
  accountId: string;
  projectId?: string;
  groupIds?: string[];
}): Promise<GroupProjectGrant[]> {
  if (filter.groupIds && filter.groupIds.length === 0) return [];
  const clauses = [
    eq(roleAssignments.accountId, filter.accountId),
    eq(roleAssignments.scopeType, 'project'),
    eq(roleAssignments.principalType, 'group'),
    isNull(roleAssignments.objectType),
    isNull(iamRoles.accountId),
    ne(iamRoles.key, OBJECT_MARKER_ROLE_KEY),
    live(),
  ];
  if (filter.projectId) clauses.push(eq(roleAssignments.scopeId, filter.projectId));
  if (filter.groupIds) clauses.push(inArray(roleAssignments.principalId, filter.groupIds));
  const rows = await baseQuery(and(...clauses));
  return foldStrongestPerKey(rows, (r) => `${r.principalId}|${r.scopeId}`).map((r) => ({
    assignmentId: r.assignmentId,
    accountId: r.accountId,
    projectId: r.scopeId!,
    groupId: r.principalId,
    role: r.roleKey as ProjectRoleKey,
    grantedBy: r.grantedBy,
    expiresAt: r.expiresAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

/**
 * The legacy stores had ONE row per (principal, project); the canonical store
 * allows two (a member row and a manager row can coexist). Collapse to the
 * strongest so a read model never renders the same person twice, which is the
 * same fold the engine applies when it picks a project role.
 */
function foldStrongestPerKey(rows: RawRow[], keyOf: (r: RawRow) => string): RawRow[] {
  const best = new Map<string, RawRow>();
  for (const r of rows) {
    const key = keyOf(r);
    const held = best.get(key);
    const rank = PROJECT_ROLE_RANK[r.roleKey as ProjectRoleKey] ?? 0;
    const heldRank = held ? (PROJECT_ROLE_RANK[held.roleKey as ProjectRoleKey] ?? 0) : -1;
    if (rank > heldRank) best.set(key, r);
  }
  return [...best.values()];
}

// ─── 4. Custom-role bindings (was iam_policies) ─────────────────────────────

export interface CustomRoleBinding {
  /** The assignment id. Serialized as `policy_id` on the legacy wire. */
  policyId: string;
  accountId: string;
  principalType: LegacyPrincipalType;
  principalId: string;
  roleId: string;
  roleKey: string;
  roleName: string;
  scopeType: ScopeType;
  scopeId: string | null;
  expiresAt: Date | null;
  grantedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Assignments of ACCOUNT-AUTHORED (non-system) roles — what `iam_policies` held.
 * Object assignments are excluded: they are the resource-grant channel, and the
 * legacy policies table never held one.
 */
export async function customRoleBindings(filter: {
  accountId: string;
  principalType?: LegacyPrincipalType;
  principalId?: string;
  principals?: Array<{ type: LegacyPrincipalType; id: string }>;
  scopeType?: ScopeType;
  /** `null` selects account scope (scope_id IS NULL), a string selects one project. */
  scopeId?: string | null;
  roleId?: string;
  /** Restrict to bindings that reach ONE project: its own rows plus every
   *  account-scoped binding, which covers every project by definition. */
  reachingProjectId?: string;
}): Promise<CustomRoleBinding[]> {
  const clauses = [
    eq(roleAssignments.accountId, filter.accountId),
    isNotNull(iamRoles.accountId),
    isNull(roleAssignments.objectType),
    live(),
  ];
  if (filter.principalType) {
    const canonical = legacyToCanonicalPrincipal(filter.principalType);
    if (!canonical) return [];
    clauses.push(eq(roleAssignments.principalType, canonical));
  }
  if (filter.principalId) clauses.push(eq(roleAssignments.principalId, filter.principalId));
  if (filter.principals) {
    if (filter.principals.length === 0) return [];
    const ors = filter.principals
      .map((p) => {
        const canonical = legacyToCanonicalPrincipal(p.type);
        return canonical
          ? and(eq(roleAssignments.principalType, canonical), eq(roleAssignments.principalId, p.id))
          : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    if (ors.length === 0) return [];
    clauses.push(or(...ors)!);
  }
  if (filter.scopeType) clauses.push(eq(roleAssignments.scopeType, filter.scopeType));
  if (filter.scopeId === null) clauses.push(isNull(roleAssignments.scopeId));
  else if (typeof filter.scopeId === 'string') clauses.push(eq(roleAssignments.scopeId, filter.scopeId));
  if (filter.roleId) clauses.push(eq(roleAssignments.roleId, filter.roleId));
  if (filter.reachingProjectId) {
    clauses.push(
      or(
        and(eq(roleAssignments.scopeType, 'project'), eq(roleAssignments.scopeId, filter.reachingProjectId)),
        eq(roleAssignments.scopeType, 'account'),
      )!,
    );
  }

  const rows = await baseQuery(and(...clauses));
  const out: CustomRoleBinding[] = [];
  for (const r of rows) {
    const principalType = canonicalToLegacyPrincipal(r.principalType);
    // A `pending` principal has no legacy policy shape — an invitation's staged
    // grants are surfaced by the invite read models, not by the policy list.
    if (!principalType) continue;
    out.push({
      policyId: r.assignmentId,
      accountId: r.accountId,
      principalType,
      principalId: r.principalId,
      roleId: r.roleId,
      roleKey: r.roleKey,
      roleName: r.roleName,
      scopeType: r.scopeType as ScopeType,
      scopeId: r.scopeId,
      expiresAt: r.expiresAt,
      grantedBy: r.grantedBy,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    });
  }
  return out;
}

/** How many live bindings reference a role — the roles-usage read model. */
export async function countRoleBindings(accountId: string, roleId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(roleAssignments)
    .where(
      and(
        eq(roleAssignments.accountId, accountId),
        eq(roleAssignments.roleId, roleId),
        isNull(roleAssignments.objectType),
      ),
    );
  return Number(row?.n ?? 0);
}

// ─── 5. Object grants (was iam_resource_grants) ─────────────────────────────

export interface ObjectGrantRow {
  /** The assignment id. Serialized as `grant_id` on the legacy wire. */
  grantId: string;
  accountId: string;
  projectId: string;
  /** Legacy wire vocabulary: `member` | `group`. */
  principalType: 'member' | 'group';
  principalId: string;
  resourceType: string;
  resourceId: string;
  expiresAt: Date | null;
  grantedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export async function objectGrantRows(filter: {
  accountId?: string;
  projectId?: string;
  projectIds?: string[];
  includeExpired?: boolean;
}): Promise<ObjectGrantRow[]> {
  if (filter.projectIds && filter.projectIds.length === 0) return [];
  const clauses = [eq(roleAssignments.scopeType, 'project'), isNotNull(roleAssignments.objectType)];
  if (filter.accountId) clauses.push(eq(roleAssignments.accountId, filter.accountId));
  if (filter.projectId) clauses.push(eq(roleAssignments.scopeId, filter.projectId));
  if (filter.projectIds) clauses.push(inArray(roleAssignments.scopeId, filter.projectIds));
  if (!filter.includeExpired) clauses.push(live());
  const rows = await baseQuery(and(...clauses));
  const out: ObjectGrantRow[] = [];
  for (const r of rows) {
    if (!r.objectType || !r.objectId || !r.scopeId) continue;
    // Only a human or a group can hold an object grant — the legacy table's
    // principal_type enum had exactly those two values.
    if (r.principalType !== 'user' && r.principalType !== 'group') continue;
    out.push({
      grantId: r.assignmentId,
      accountId: r.accountId,
      projectId: r.scopeId,
      principalType: r.principalType === 'user' ? 'member' : 'group',
      principalId: r.principalId,
      resourceType: r.objectType,
      resourceId: r.objectId,
      expiresAt: r.expiresAt,
      grantedBy: r.grantedBy,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    });
  }
  return out;
}

// ─── 6. The fold (was projects/access.ts foldEffectiveProjectAccess) ────────

export interface GroupSourceLabel {
  group_id: string;
  group_name: string;
  role: ProjectRoleKey;
}

export interface FoldedProjectAccess {
  /** `null` = this principal reaches the project through none of the three
   *  channels. The legacy fold emitted null here and the UI renders "No access"
   *  from it, so the nullability is part of the wire contract, not an oversight. */
  effective_project_role: ProjectRoleKey | null;
  effective_source: 'implicit' | 'direct' | 'group' | null;
  group_sources: GroupSourceLabel[];
}

/**
 * The strongest role a principal holds on one project, and WHERE it came from.
 *
 * Max role wins; a tie keeps the earlier channel, so precedence reads
 * `implicit -> direct -> group` — the order the UI labels read best in
 * ("Manager (account admin)" beats "Manager (via Engineering)"). Byte-identical
 * to the `foldEffectiveProjectAccess` it replaces, nulls included.
 */
export function foldProjectAccess(input: {
  accountRole: AccountRoleKey | null;
  directRole: ProjectRoleKey | null;
  groupSources: GroupSourceLabel[];
}): FoldedProjectAccess {
  let effective: ProjectRoleKey | null = null;
  let source: FoldedProjectAccess['effective_source'] = null;

  if (isAccountManagerRole(input.accountRole)) {
    effective = 'manager';
    source = 'implicit';
  }
  if (input.directRole) {
    if (!effective || PROJECT_ROLE_RANK[input.directRole] > PROJECT_ROLE_RANK[effective]) {
      effective = input.directRole;
      source = 'direct';
    }
  }
  for (const g of input.groupSources) {
    if (!effective || PROJECT_ROLE_RANK[g.role] > PROJECT_ROLE_RANK[effective]) {
      effective = g.role;
      source = 'group';
    }
  }

  return {
    effective_project_role: effective,
    effective_source: source,
    // Strongest contributor first, so the UI's "via X group" chip picks it.
    group_sources: [...input.groupSources].sort(
      (a, b) => PROJECT_ROLE_RANK[b.role] - PROJECT_ROLE_RANK[a.role],
    ),
  };
}
