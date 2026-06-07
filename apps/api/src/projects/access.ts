export type ProjectRole = 'manager' | 'editor' | 'viewer';
export type AccountRole = 'owner' | 'admin' | 'member';
export type ProjectAccessAction = 'read' | 'write' | 'manage';

export function isAccountManager(role: AccountRole): boolean {
  return role === 'owner' || role === 'admin';
}

export function roleAllows(role: ProjectRole | null, action: ProjectAccessAction): boolean {
  if (!role) return false;
  if (action === 'read') return true;
  if (action === 'write') return role === 'editor' || role === 'manager';
  return role === 'manager';
}

export function effectiveProjectRole(
  accountRole: AccountRole,
  projectRole: ProjectRole | null,
): ProjectRole | null {
  if (isAccountManager(accountRole)) return 'manager';
  return projectRole;
}

export function parseProjectRole(value: unknown): ProjectRole | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return normalized === 'manager' || normalized === 'editor' || normalized === 'viewer'
    ? normalized
    : null;
}

// ─── Effective access fold ───────────────────────────────────────────────
//
// Used by GET /v1/projects/:projectId/access to compute each member's
// effective access from the three independent sources V2 supports:
//   - implicit (account owner/admin → Manager on every project)
//   - direct   (explicit project_members row with a project_role)
//   - group    (project_group_grants attaching a group the user is in)
//
// Folding rule: max role wins. Source label records which path produced
// that max — used by the UI to render "via X group" or "Account admin"
// next to the row. Tie-break (multiple paths grant the same role):
// implicit → direct → group, matching the order admins reason about it.
//
// Pure so it's easy to test without spinning up the DB.

type AccessSourceTag = 'implicit' | 'direct' | 'group';

export interface GroupSource {
  group_id: string;
  group_name: string;
  role: ProjectRole;
}

export interface EffectiveAccessFold {
  effective_project_role: ProjectRole | null;
  effective_source: AccessSourceTag | null;
  group_sources: GroupSource[];
}

const PROJECT_ROLE_RANK: Record<ProjectRole, number> = {
  viewer: 1,
  editor: 2,
  manager: 3,
};

export function maxProjectRole(a: ProjectRole, b: ProjectRole): ProjectRole {
  return PROJECT_ROLE_RANK[a] >= PROJECT_ROLE_RANK[b] ? a : b;
}

export function foldEffectiveProjectAccess(input: {
  accountRole: AccountRole;
  directRole: ProjectRole | null;
  groupSources: GroupSource[];
}): EffectiveAccessFold {
  let effective: ProjectRole | null = null;
  let source: AccessSourceTag | null = null;

  if (isAccountManager(input.accountRole)) {
    effective = 'manager';
    source = 'implicit';
  }

  if (input.directRole) {
    if (!effective || PROJECT_ROLE_RANK[input.directRole] > PROJECT_ROLE_RANK[effective]) {
      effective = input.directRole;
      source = 'direct';
    }
  }

  for (const gs of input.groupSources) {
    if (!effective) {
      effective = gs.role;
      source = 'group';
    } else {
      const merged = maxProjectRole(effective, gs.role);
      if (merged !== effective) {
        effective = merged;
        source = 'group';
      }
    }
  }

  // Group sources sorted by descending role so the UI's "via X group"
  // chip picks the strongest contributor first.
  const sortedGroupSources = input.groupSources
    .slice()
    .sort((a, b) => PROJECT_ROLE_RANK[b.role] - PROJECT_ROLE_RANK[a.role]);

  return {
    effective_project_role: effective,
    effective_source: source,
    group_sources: sortedGroupSources,
  };
}
