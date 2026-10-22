// Pure helpers for IAM V2 list rendering. Extracted from groups-tab,
// group-detail page, project Members page so the precedence + sort logic
// can be unit-tested without spinning up React or a query client.
//
// Two small problems, one file:
//
//   1. Sorting + counting group members whose ACCOUNT role overrides
//      the group's project grant (super-admin > owner > admin > member).
//      Used by the Group detail → Group members warning banner.
//
//   2. Deciding whether a project Members row has access only via a group
//      (no implicit Manager, no direct project_members row) — the callers
//      render their own "Inherited …" copy on top of it.

// ONE role model. These are re-exports of the SDK's unions, not local copies —
// this file used to declare its own `AccountRole` / `ProjectRole`, shadowing
// `@kortix/sdk`'s, so the same two names meant two things depending on the
// import path.
export type { AccountRole, ProjectRole } from '@kortix/sdk';

import type { AccountRole, ProjectRole } from '@kortix/sdk';

export interface AccountMeta {
  email: string | null;
  accountRole: AccountRole;
  isSuperAdmin: boolean;
}

/**
 * True when this member's account-level standing gives them Manager on
 * every project regardless of the group's role.
 */
export function isOverridingAccountRole(meta: AccountMeta): boolean {
  return meta.isSuperAdmin || meta.accountRole === 'owner' || meta.accountRole === 'admin';
}

/**
 * Number of members whose access overrides the group's project grants.
 * Drives the amber warning banner on the Group members card.
 */
export function countOverridingMembers(
  members: Array<{ user_id: string }>,
  metaByUserId: Map<string, AccountMeta>,
): number {
  let n = 0;
  for (const m of members) {
    const meta = metaByUserId.get(m.user_id);
    if (meta && isOverridingAccountRole(meta)) n++;
  }
  return n;
}

const OVERRIDE_RANK: Record<AccountRole | 'super_admin' | 'unknown', number> = {
  super_admin: 0,
  owner: 1,
  admin: 2,
  member: 3,
  unknown: 4,
};

function overrideRank(meta: AccountMeta | undefined): number {
  if (!meta) return OVERRIDE_RANK.unknown;
  if (meta.isSuperAdmin) return OVERRIDE_RANK.super_admin;
  return OVERRIDE_RANK[meta.accountRole];
}

/**
 * Sort group members so override-prone rows (super-admin, owner, admin)
 * float to the top — the warning banner mentions "N override", and we
 * want those N rows to be the first N in the list. Tie-break: ascending
 * addedAt so older members stay near the top within each tier.
 */
export function sortGroupMembersByOverride<T extends { user_id: string; added_at: string }>(
  members: T[],
  metaByUserId: Map<string, AccountMeta>,
): T[] {
  return [...members].sort((a, b) => {
    const ra = overrideRank(metaByUserId.get(a.user_id));
    const rb = overrideRank(metaByUserId.get(b.user_id));
    if (ra !== rb) return ra - rb;
    return new Date(a.added_at).getTime() - new Date(b.added_at).getTime();
  });
}

// ─── Project Members → inherited-via-group row ──────────────────────────

export interface ProjectAccessRowInput {
  has_implicit_access: boolean;
  project_role: ProjectRole | null;
  effective_project_role: ProjectRole | null;
  group_sources?: Array<{ group_name: string; role: ProjectRole }>;
}

/**
 * True when the row's only access path is a group attachment (no
 * implicit Manager, no direct project_members row).
 */
export function isInheritedFromGroupOnly(row: ProjectAccessRowInput): boolean {
  return (
    !row.has_implicit_access &&
    !row.project_role &&
    row.effective_project_role !== null &&
    (row.group_sources?.length ?? 0) > 0
  );
}
