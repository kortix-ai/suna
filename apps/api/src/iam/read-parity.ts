/**
 * READ-model parity: the legacy grant stores vs `role_assignments`, on one DB.
 *
 * `parity-harness.ts` proves the ENGINE returns the same verdict from the
 * canonical store. This proves the other half — that every access SCREEN
 * rebuilt on top of `role_assignments` returns the same rows as the query it
 * replaced. Both run against the same fixture, which writes ONLY the legacy
 * tables and lets the dual-write mirror triggers populate the canonical one, so
 * a divergence here is a divergence in the projection, never in the seed.
 *
 * Seven projections, one per read model the web renders:
 *   RM1   GET /projects/:id/access          members + groups + policies + grants
 *   RM12  GET /accounts/:id/members         account role + explicit projects
 *   RM7   GET …/iam/members/:userId/project-access
 *   RM46  GET /accounts/:id/iam/policies
 *   RM52  GET /accounts/:id/iam/resource-grants
 *   RM4   GET /projects                     effective_role label
 *   RM8   GET …/iam/groups/:groupId/project-grants
 *
 * ONE deliberate normalization, and it is on the LEGACY side: expired rows are
 * dropped before comparing. None of the legacy queries filtered `expires_at`,
 * so the Members page listed a lapsed grant as live access and folded it into
 * the effective role — while the engine had already stopped honouring it. The
 * canonical projections filter, exactly as the engine does. Comparing the live
 * projection of both is what makes the remaining difference zero; the behaviour
 * CHANGE is asserted separately (see integration-rbac-read-parity.test.ts).
 */
import { sql } from 'drizzle-orm';
import { db } from '../shared/db';
import {
  accountRoleMap,
  customRoleBindings,
  foldProjectAccess,
  groupProjectGrants,
  isAccountManagerRole,
  objectGrantRows,
  projectRoleGrants,
  type AccountRoleKey,
  type GroupSourceLabel,
  type ProjectRoleKey,
} from './read-models';

export interface ReadParityDiff {
  model: string;
  key: string;
  legacy: unknown;
  canonical: unknown;
}

export interface ReadParityResult {
  compared: number;
  diffs: ReadParityDiff[];
}

async function rows<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const out = await db.execute(sql.raw(interpolate(text, params)));
  return (out as unknown as { rows?: T[] }).rows ?? (out as unknown as T[]);
}

/** Fixture-only interpolation: every value is a uuid the harness authored. */
function interpolate(text: string, params: unknown[]): string {
  return text.replace(/\$(\d+)/g, (_, i) => {
    const v = params[Number(i) - 1];
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return `'${String(v).replace(/'/g, "''")}'`;
  });
}

/** `normalizeProjectRole`, for the legacy side's retired enum labels. */
function foldLegacyProjectRole(raw: string): ProjectRoleKey {
  if (raw === 'editor') return 'manager';
  if (raw === 'viewer' || raw === 'user') return 'member';
  return raw as ProjectRoleKey;
}

function iso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return new Date(v as string).toISOString();
}

function sortJson(values: unknown[]): string[] {
  return values.map((v) => JSON.stringify(v)).sort();
}

function compare(
  model: string,
  legacy: unknown[],
  canonical: unknown[],
  out: ReadParityDiff[],
): number {
  const a = sortJson(legacy);
  const b = sortJson(canonical);
  const onlyLegacy = a.filter((x) => !b.includes(x));
  const onlyCanonical = b.filter((x) => !a.includes(x));
  for (const x of onlyLegacy) out.push({ model, key: 'only-in-legacy', legacy: JSON.parse(x), canonical: null });
  for (const x of onlyCanonical) out.push({ model, key: 'only-in-canonical', legacy: null, canonical: JSON.parse(x) });
  return Math.max(a.length, b.length);
}

// ─── RM1 · GET /projects/:projectId/access ──────────────────────────────────

interface AccessMemberShape {
  user_id: string;
  account_role: string;
  project_role: string | null;
  effective_project_role: string | null;
  effective_source: string | null;
  has_implicit_access: boolean;
  group_sources: GroupSourceLabel[];
  granted_by: string | null;
  expires_at: string | null;
  custom_role_policies: Array<{ role_id: string; scope_type: string; source: string; group_id: string | null }>;
  resource_grants: Array<{ resource_type: string; resource_id: string; source: string; group_id: string | null }>;
}

async function legacyProjectAccess(accountId: string, projectId: string): Promise<AccessMemberShape[]> {
  const members = await rows<{ user_id: string; account_role: string }>(
    `select user_id::text, account_role::text from kortix.account_members where account_id = $1`,
    [accountId],
  );
  const direct = await rows<{ user_id: string; project_role: string; granted_by: string | null; expires_at: string | null }>(
    `select user_id::text, project_role::text, granted_by::text, expires_at
       from kortix.project_members
      where project_id = $1 and (expires_at is null or expires_at > now())`,
    [projectId],
  );
  const groupGrants = await rows<{ group_id: string; group_name: string; role: string }>(
    `select g.group_id::text, ag.name as group_name, g.role::text
       from kortix.project_group_grants g
       join kortix.account_groups ag on ag.group_id = g.group_id
      where g.project_id = $1 and (g.expires_at is null or g.expires_at > now())`,
    [projectId],
  );
  const policies = await rows<{
    principal_type: string;
    principal_id: string;
    role_id: string;
    scope_type: string;
  }>(
    `select principal_type::text, principal_id::text, role_id::text, scope_type::text
       from kortix.iam_policies
      where account_id = $1
        and principal_type in ('member','group')
        and (expires_at is null or expires_at > now())
        and ((scope_type = 'project' and scope_id = $2) or scope_type = 'account')`,
    [accountId, projectId],
  );
  const grants = await rows<{
    principal_type: string;
    principal_id: string;
    resource_type: string;
    resource_id: string;
  }>(
    `select principal_type::text, principal_id::text, resource_type::text, resource_id
       from kortix.iam_resource_grants
      where project_id = $1 and effect = 'allow'
        and resource_type <> 'secret'
        and (expires_at is null or expires_at > now())`,
    [projectId],
  );
  const groupMembers = await rows<{ group_id: string; user_id: string }>(
    `select gm.group_id::text, gm.user_id::text
       from kortix.account_group_members gm
       join kortix.account_groups ag on ag.group_id = gm.group_id
      where ag.account_id = $1`,
    [accountId],
  );
  return assembleAccess(members, direct, groupGrants, policies, grants, groupMembers);
}

async function canonicalProjectAccess(accountId: string, projectId: string): Promise<AccessMemberShape[]> {
  const [identity, roles, direct, groupGrants, bindings, grants, groupMembers] = await Promise.all([
    rows<{ user_id: string }>(`select user_id::text from kortix.account_members where account_id = $1`, [accountId]),
    accountRoleMap(accountId),
    projectRoleGrants({ accountId, projectId }),
    groupProjectGrants({ accountId, projectId }),
    customRoleBindings({ accountId, reachingProjectId: projectId, principalTypes: ['member', 'group'] }),
    objectGrantRows({ accountId, projectId }),
    rows<{ group_id: string; user_id: string }>(
      `select gm.group_id::text, gm.user_id::text
         from kortix.account_group_members gm
         join kortix.account_groups ag on ag.group_id = gm.group_id
        where ag.account_id = $1`,
      [accountId],
    ),
  ]);
  const groupNames = await rows<{ group_id: string; name: string }>(
    `select group_id::text, name from kortix.account_groups where account_id = $1`,
    [accountId],
  );
  const nameById = new Map(groupNames.map((g) => [g.group_id, g.name] as const));
  return assembleAccess(
    identity.map((r) => ({ user_id: r.user_id, account_role: roles.get(r.user_id) ?? 'member' })),
    direct.map((g) => ({
      user_id: g.userId,
      project_role: g.projectRole,
      granted_by: g.grantedBy,
      expires_at: g.expiresAt ? g.expiresAt.toISOString() : null,
    })),
    groupGrants
      .filter((g) => nameById.has(g.groupId))
      .map((g) => ({ group_id: g.groupId, group_name: nameById.get(g.groupId)!, role: g.role })),
    bindings
      .filter((b) => b.principalType !== 'token')
      .map((b) => ({
        principal_type: b.principalType,
        principal_id: b.principalId,
        role_id: b.roleId,
        scope_type: b.scopeType,
      })),
    grants
      .filter((g) => g.resourceType !== 'secret')
      .map((g) => ({
        principal_type: g.principalType,
        principal_id: g.principalId,
        resource_type: g.resourceType,
        resource_id: g.resourceId,
      })),
    groupMembers,
  );
}

/** The fold both sides share, so the comparison is of the DATA, not the code. */
function assembleAccess(
  members: Array<{ user_id: string; account_role: string }>,
  direct: Array<{ user_id: string; project_role: string; granted_by: string | null; expires_at: string | null }>,
  groupGrants: Array<{ group_id: string; group_name: string; role: string }>,
  policies: Array<{ principal_type: string; principal_id: string; role_id: string; scope_type: string }>,
  grants: Array<{ principal_type: string; principal_id: string; resource_type: string; resource_id: string }>,
  groupMembers: Array<{ group_id: string; user_id: string }>,
): AccessMemberShape[] {
  const usersByGroup = new Map<string, string[]>();
  for (const m of groupMembers) {
    const list = usersByGroup.get(m.group_id) ?? [];
    list.push(m.user_id);
    usersByGroup.set(m.group_id, list);
  }
  const directByUser = new Map(direct.map((d) => [d.user_id, d] as const));
  const grantByGroup = new Map(groupGrants.map((g) => [g.group_id, g] as const));

  const groupSourcesByUser = new Map<string, GroupSourceLabel[]>();
  for (const [groupId, users] of usersByGroup) {
    const grant = grantByGroup.get(groupId);
    if (!grant) continue;
    for (const userId of users) {
      const list = groupSourcesByUser.get(userId) ?? [];
      list.push({
        group_id: groupId,
        group_name: grant.group_name,
        role: foldLegacyProjectRole(grant.role),
      });
      groupSourcesByUser.set(userId, list);
    }
  }

  const policiesByUser = new Map<string, AccessMemberShape['custom_role_policies']>();
  for (const p of policies) {
    const entry = { role_id: p.role_id, scope_type: p.scope_type };
    if (p.principal_type === 'group') {
      for (const userId of usersByGroup.get(p.principal_id) ?? []) {
        const list = policiesByUser.get(userId) ?? [];
        list.push({ ...entry, source: 'group', group_id: p.principal_id });
        policiesByUser.set(userId, list);
      }
    } else {
      const list = policiesByUser.get(p.principal_id) ?? [];
      list.push({ ...entry, source: 'direct', group_id: null });
      policiesByUser.set(p.principal_id, list);
    }
  }

  const grantsByUser = new Map<string, AccessMemberShape['resource_grants']>();
  for (const g of grants) {
    const entry = { resource_type: g.resource_type, resource_id: g.resource_id };
    if (g.principal_type === 'group') {
      for (const userId of usersByGroup.get(g.principal_id) ?? []) {
        const list = grantsByUser.get(userId) ?? [];
        list.push({ ...entry, source: 'group', group_id: g.principal_id });
        grantsByUser.set(userId, list);
      }
    } else {
      const list = grantsByUser.get(g.principal_id) ?? [];
      list.push({ ...entry, source: 'direct', group_id: null });
      grantsByUser.set(g.principal_id, list);
    }
  }

  return members.map((m) => {
    const d = directByUser.get(m.user_id);
    const projectRole = d ? foldLegacyProjectRole(d.project_role) : null;
    const groupSources = groupSourcesByUser.get(m.user_id) ?? [];
    const fold = foldProjectAccess({
      accountRole: m.account_role as AccountRoleKey,
      directRole: projectRole,
      groupSources,
    });
    return {
      user_id: m.user_id,
      account_role: m.account_role,
      project_role: projectRole,
      effective_project_role: fold.effective_project_role,
      effective_source: fold.effective_source,
      has_implicit_access: isAccountManagerRole(m.account_role),
      group_sources: fold.group_sources,
      granted_by: d?.granted_by ?? null,
      expires_at: iso(d?.expires_at ?? null),
      custom_role_policies: (policiesByUser.get(m.user_id) ?? []).sort((x, y) =>
        JSON.stringify(x).localeCompare(JSON.stringify(y)),
      ),
      resource_grants: (grantsByUser.get(m.user_id) ?? []).sort((x, y) =>
        JSON.stringify(x).localeCompare(JSON.stringify(y)),
      ),
    };
  });
}

// ─── RM12 · GET /accounts/:accountId/members ────────────────────────────────

interface MemberDirectoryShape {
  user_id: string;
  account_role: string;
  explicit_project_count: number;
  projects: Array<{ project_id: string; role: string }>;
}

async function legacyMemberDirectory(accountId: string): Promise<MemberDirectoryShape[]> {
  const members = await rows<{ user_id: string; account_role: string }>(
    `select user_id::text, account_role::text from kortix.account_members where account_id = $1`,
    [accountId],
  );
  const grants = await rows<{ user_id: string; project_id: string; role: string }>(
    `select pm.user_id::text, pm.project_id::text, pm.project_role::text as role
       from kortix.project_members pm
       join kortix.projects p on p.project_id = pm.project_id
      where pm.account_id = $1 and p.status = 'active'
        and (pm.expires_at is null or pm.expires_at > now())`,
    [accountId],
  );
  return assembleDirectory(members, grants.map((g) => ({ ...g, role: foldLegacyProjectRole(g.role) })));
}

async function canonicalMemberDirectory(accountId: string): Promise<MemberDirectoryShape[]> {
  const [identity, roles, grants, active] = await Promise.all([
    rows<{ user_id: string }>(`select user_id::text from kortix.account_members where account_id = $1`, [accountId]),
    accountRoleMap(accountId),
    projectRoleGrants({ accountId }),
    rows<{ project_id: string }>(
      `select project_id::text from kortix.projects where account_id = $1 and status = 'active'`,
      [accountId],
    ),
  ]);
  const activeIds = new Set(active.map((p) => p.project_id));
  return assembleDirectory(
    identity.map((r) => ({ user_id: r.user_id, account_role: roles.get(r.user_id) ?? 'member' })),
    grants
      .filter((g) => activeIds.has(g.projectId))
      .map((g) => ({ user_id: g.userId, project_id: g.projectId, role: g.projectRole })),
  );
}

function assembleDirectory(
  members: Array<{ user_id: string; account_role: string }>,
  grants: Array<{ user_id: string; project_id: string; role: string }>,
): MemberDirectoryShape[] {
  const byUser = new Map<string, Array<{ project_id: string; role: string }>>();
  for (const g of grants) {
    const list = byUser.get(g.user_id) ?? [];
    list.push({ project_id: g.project_id, role: g.role });
    byUser.set(g.user_id, list);
  }
  return members.map((m) => {
    const list = (byUser.get(m.user_id) ?? []).sort((a, b) => a.project_id.localeCompare(b.project_id));
    return {
      user_id: m.user_id,
      account_role: m.account_role,
      explicit_project_count: list.length,
      projects: list,
    };
  });
}

// ─── RM7 · GET …/iam/members/:userId/project-access ─────────────────────────

interface ProjectAccessShape {
  project_id: string;
  role: string;
  sources: string[];
}

function assembleProjectAccess(
  accountRole: string | null,
  activeProjectIds: string[],
  direct: Array<{ project_id: string; role: string }>,
  viaGroup: Array<{ project_id: string; role: string }>,
): ProjectAccessShape[] {
  if (!accountRole) return [];
  const rank: Record<string, number> = { member: 1, manager: 2 };
  const byProject = new Map<string, { role: string; sources: string[] }>();
  if (isAccountManagerRole(accountRole)) {
    for (const id of activeProjectIds) byProject.set(id, { role: 'manager', sources: ['implicit'] });
  }
  const add = (entries: Array<{ project_id: string; role: string }>, tag: string) => {
    for (const e of entries) {
      const cur = byProject.get(e.project_id);
      if (cur) {
        if (rank[e.role] > rank[cur.role]) cur.role = e.role;
        if (!cur.sources.includes(tag)) cur.sources.push(tag);
      } else {
        byProject.set(e.project_id, { role: e.role, sources: [tag] });
      }
    }
  };
  add(direct, 'direct');
  add(viaGroup, 'group');
  const activeSet = new Set(activeProjectIds);
  return [...byProject.entries()]
    .filter(([id]) => activeSet.has(id))
    .map(([project_id, v]) => ({ project_id, role: v.role, sources: [...v.sources].sort() }));
}

async function legacyMemberProjectAccess(accountId: string, userId: string): Promise<ProjectAccessShape[]> {
  const [[membership], active, direct, groups] = await Promise.all([
    rows<{ account_role: string }>(
      `select account_role::text from kortix.account_members where account_id = $1 and user_id = $2`,
      [accountId, userId],
    ),
    rows<{ project_id: string }>(
      `select project_id::text from kortix.projects where account_id = $1 and status = 'active'`,
      [accountId],
    ),
    rows<{ project_id: string; role: string }>(
      `select project_id::text, project_role::text as role from kortix.project_members
        where account_id = $1 and user_id = $2 and (expires_at is null or expires_at > now())`,
      [accountId, userId],
    ),
    rows<{ project_id: string; role: string }>(
      `select g.project_id::text, g.role::text
         from kortix.project_group_grants g
         join kortix.account_group_members gm on gm.group_id = g.group_id
        where g.account_id = $1 and gm.user_id = $2
          and (g.expires_at is null or g.expires_at > now())`,
      [accountId, userId],
    ),
  ]);
  return assembleProjectAccess(
    membership?.account_role ?? null,
    active.map((p) => p.project_id),
    direct.map((d) => ({ project_id: d.project_id, role: foldLegacyProjectRole(d.role) })),
    groups.map((g) => ({ project_id: g.project_id, role: foldLegacyProjectRole(g.role) })),
  );
}

async function canonicalMemberProjectAccess(accountId: string, userId: string): Promise<ProjectAccessShape[]> {
  const [roles, active, direct, groupIds] = await Promise.all([
    accountRoleMap(accountId),
    rows<{ project_id: string }>(
      `select project_id::text from kortix.projects where account_id = $1 and status = 'active'`,
      [accountId],
    ),
    projectRoleGrants({ accountId, userId }),
    rows<{ group_id: string }>(
      `select group_id::text from kortix.account_group_members where user_id = $1`,
      [userId],
    ),
  ]);
  const viaGroup = await groupProjectGrants({ accountId, groupIds: groupIds.map((g) => g.group_id) });
  return assembleProjectAccess(
    roles.get(userId) ?? null,
    active.map((p) => p.project_id),
    direct.map((d) => ({ project_id: d.projectId, role: d.projectRole })),
    viaGroup.map((g) => ({ project_id: g.projectId, role: g.role })),
  );
}

// ─── RM46 · GET /accounts/:accountId/iam/policies ───────────────────────────

interface PolicyShape {
  principal_type: string;
  principal_id: string;
  scope_type: string;
  scope_id: string | null;
  role_id: string;
  expires_at: string | null;
}

async function legacyPolicies(accountId: string): Promise<PolicyShape[]> {
  const out = await rows<PolicyShape>(
    `select principal_type::text, principal_id::text, scope_type::text, scope_id::text, role_id::text, expires_at
       from kortix.iam_policies
      where account_id = $1 and (expires_at is null or expires_at > now())`,
    [accountId],
  );
  return out.map((r) => ({ ...r, expires_at: iso(r.expires_at) }));
}

async function canonicalPolicies(accountId: string): Promise<PolicyShape[]> {
  const bindings = await customRoleBindings({ accountId });
  return bindings.map((b) => ({
    principal_type: b.principalType,
    principal_id: b.principalId,
    scope_type: b.scopeType,
    scope_id: b.scopeId,
    role_id: b.roleId,
    expires_at: b.expiresAt ? b.expiresAt.toISOString() : null,
  }));
}

// ─── RM52 · GET /accounts/:accountId/iam/resource-grants ────────────────────

interface ResourceGrantShape {
  project_id: string;
  resource_type: string;
  resource_id: string;
  principal_type: string;
  principal_id: string;
  expires_at: string | null;
}

async function legacyResourceGrants(accountId: string): Promise<ResourceGrantShape[]> {
  const out = await rows<ResourceGrantShape>(
    `select g.project_id::text, g.resource_type::text, g.resource_id, g.principal_type::text,
            g.principal_id::text, g.expires_at
       from kortix.iam_resource_grants g
       join kortix.projects p on p.project_id = g.project_id
      where g.account_id = $1 and g.effect = 'allow' and g.resource_type <> 'secret'
        and (g.expires_at is null or g.expires_at > now())`,
    [accountId],
  );
  return out.map((r) => ({ ...r, expires_at: iso(r.expires_at) }));
}

async function canonicalResourceGrants(accountId: string): Promise<ResourceGrantShape[]> {
  const [grants, projectIds] = await Promise.all([
    objectGrantRows({ accountId }),
    rows<{ project_id: string }>(`select project_id::text from kortix.projects where account_id = $1`, [accountId]),
  ]);
  const known = new Set(projectIds.map((p) => p.project_id));
  return grants
    .filter((g) => g.resourceType !== 'secret' && known.has(g.projectId))
    .map((g) => ({
      project_id: g.projectId,
      resource_type: g.resourceType,
      resource_id: g.resourceId,
      principal_type: g.principalType,
      principal_id: g.principalId,
      expires_at: g.expiresAt ? g.expiresAt.toISOString() : null,
    }));
}

// ─── RM4 · GET /projects effective_role label ───────────────────────────────

interface ProjectLabelShape {
  project_id: string;
  effective_role: string;
}

function assembleProjectLabels(
  accountRole: string | null,
  activeProjectIds: string[],
  direct: Map<string, string>,
): ProjectLabelShape[] {
  const manager = isAccountManagerRole(accountRole);
  return activeProjectIds
    .map((project_id) => ({
      project_id,
      effective_role: manager ? 'manager' : (direct.get(project_id) ?? 'member'),
    }))
    .sort((a, b) => a.project_id.localeCompare(b.project_id));
}

async function legacyProjectLabels(accountId: string, userId: string): Promise<ProjectLabelShape[]> {
  const [[membership], active, grants] = await Promise.all([
    rows<{ account_role: string }>(
      `select account_role::text from kortix.account_members where account_id = $1 and user_id = $2`,
      [accountId, userId],
    ),
    rows<{ project_id: string }>(
      `select project_id::text from kortix.projects where account_id = $1 and status = 'active'`,
      [accountId],
    ),
    rows<{ project_id: string; role: string }>(
      `select project_id::text, project_role::text as role from kortix.project_members
        where account_id = $1 and user_id = $2 and (expires_at is null or expires_at > now())`,
      [accountId, userId],
    ),
  ]);
  return assembleProjectLabels(
    membership?.account_role ?? null,
    active.map((p) => p.project_id),
    new Map(grants.map((g) => [g.project_id, foldLegacyProjectRole(g.role)] as const)),
  );
}

async function canonicalProjectLabels(accountId: string, userId: string): Promise<ProjectLabelShape[]> {
  const [roles, active, grants] = await Promise.all([
    accountRoleMap(accountId),
    rows<{ project_id: string }>(
      `select project_id::text from kortix.projects where account_id = $1 and status = 'active'`,
      [accountId],
    ),
    projectRoleGrants({ accountId, userId }),
  ]);
  return assembleProjectLabels(
    roles.get(userId) ?? null,
    active.map((p) => p.project_id),
    new Map(grants.map((g) => [g.projectId, g.projectRole] as const)),
  );
}

// ─── RM8 · GET …/iam/groups/:groupId/project-grants ─────────────────────────

interface GroupGrantShape {
  project_id: string;
  group_id: string;
  role: string;
  expires_at: string | null;
}

async function legacyGroupGrants(accountId: string): Promise<GroupGrantShape[]> {
  const out = await rows<GroupGrantShape>(
    `select g.project_id::text, g.group_id::text, g.role::text, g.expires_at
       from kortix.project_group_grants g
       join kortix.projects p on p.project_id = g.project_id
      where g.account_id = $1 and (g.expires_at is null or g.expires_at > now())`,
    [accountId],
  );
  return out.map((r) => ({ ...r, role: foldLegacyProjectRole(r.role), expires_at: iso(r.expires_at) }));
}

async function canonicalGroupGrants(accountId: string): Promise<GroupGrantShape[]> {
  const [grants, projectIds] = await Promise.all([
    groupProjectGrants({ accountId }),
    rows<{ project_id: string }>(`select project_id::text from kortix.projects where account_id = $1`, [accountId]),
  ]);
  const known = new Set(projectIds.map((p) => p.project_id));
  return grants
    .filter((g) => known.has(g.projectId))
    .map((g) => ({
      project_id: g.projectId,
      group_id: g.groupId,
      role: g.role,
      expires_at: g.expiresAt ? g.expiresAt.toISOString() : null,
    }));
}

// ─── Runner ─────────────────────────────────────────────────────────────────

export interface ReadParityInput {
  accountId: string;
  projectIds: string[];
  userIds: string[];
}

export async function runReadParity(input: ReadParityInput): Promise<ReadParityResult> {
  const diffs: ReadParityDiff[] = [];
  let compared = 0;

  for (const projectId of input.projectIds) {
    compared += compare(
      `RM1 /projects/${projectId}/access`,
      await legacyProjectAccess(input.accountId, projectId),
      await canonicalProjectAccess(input.accountId, projectId),
      diffs,
    );
  }

  compared += compare(
    'RM12 /accounts/:id/members',
    await legacyMemberDirectory(input.accountId),
    await canonicalMemberDirectory(input.accountId),
    diffs,
  );

  for (const userId of input.userIds) {
    compared += compare(
      `RM7 /iam/members/${userId}/project-access`,
      await legacyMemberProjectAccess(input.accountId, userId),
      await canonicalMemberProjectAccess(input.accountId, userId),
      diffs,
    );
    compared += compare(
      `RM4 /projects effective_role for ${userId}`,
      await legacyProjectLabels(input.accountId, userId),
      await canonicalProjectLabels(input.accountId, userId),
      diffs,
    );
  }

  compared += compare(
    'RM46 /iam/policies',
    await legacyPolicies(input.accountId),
    await canonicalPolicies(input.accountId),
    diffs,
  );
  compared += compare(
    'RM52 /iam/resource-grants',
    await legacyResourceGrants(input.accountId),
    await canonicalResourceGrants(input.accountId),
    diffs,
  );
  compared += compare(
    'RM8 /iam/groups/:id/project-grants',
    await legacyGroupGrants(input.accountId),
    await canonicalGroupGrants(input.accountId),
    diffs,
  );

  return { compared, diffs };
}
