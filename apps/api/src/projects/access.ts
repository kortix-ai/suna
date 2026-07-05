// `member` is the floor project role (renamed from `user`). The retired `user`
// and `viewer` tiers fold into it — see normalizeProjectRole in iam/role-perms.ts,
// the canonical parser (this module no longer keeps its own copy).
import {
  maxProjectRole,
  PROJECT_ROLE_RANK,
  type AccountRole,
  type ProjectRole,
} from '../iam/role-perms';

export type { AccountRole, ProjectRole };

// 'session' sits between 'read' and 'write': any project member (a plain
// `member` included) may start and run sessions, but not customize the project.
export type ProjectAccessAction = 'read' | 'session' | 'write' | 'manage';

export function isAccountManager(role: AccountRole): boolean {
  return role === 'owner' || role === 'admin';
}

/**
 * Coarse action gate. NOTE: after the project-role collapse (manager
 * retired, editor is the only top project role), 'write' and 'manage' are
 * the SAME check — both require the top project role. This is intentionally
 * coarser than the real V2 leaf-action model: it does NOT grant
 * project.delete / project.members.manage / project.gateway.keys.manage,
 * which moved to ACCOUNT owner/admin authority only (role-perms.ts's
 * ACCOUNT_ONLY_PROJECT_ACTIONS) and are asserted separately via
 * `assertProjectCapability` wherever they matter (see r6.ts's DELETE route
 * and the resource-grants POST route). Callers that need to gate on THAT
 * account-only authority specifically (e.g. an "Archive project" or "Manage
 * members" button) should check `isAccountManager(accountRole)` directly,
 * not this function.
 */
export function roleAllows(role: ProjectRole | null, action: ProjectAccessAction): boolean {
  if (!role) return false;
  if (action === 'read') return true;
  // Every project role can use sessions — `member` is the base *usable* role.
  if (action === 'session') return true;
  return role === 'editor';
}

export function effectiveProjectRole(
  accountRole: AccountRole,
  projectRole: ProjectRole | null,
): ProjectRole | null {
  if (isAccountManager(accountRole)) return 'editor';
  return projectRole;
}

// ─── Effective access fold ───────────────────────────────────────────────
//
// Used by GET /v1/projects/:projectId/access to compute each member's
// effective access from the three independent sources V2 supports:
//   - implicit (account owner/admin → Editor, the top project role, on every project)
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

export function foldEffectiveProjectAccess(input: {
  accountRole: AccountRole;
  directRole: ProjectRole | null;
  groupSources: GroupSource[];
}): EffectiveAccessFold {
  let effective: ProjectRole | null = null;
  let source: AccessSourceTag | null = null;

  if (isAccountManager(input.accountRole)) {
    effective = 'editor';
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
