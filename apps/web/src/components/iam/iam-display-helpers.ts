// Pure helpers for IAM V2 list rendering. Extracted from groups-tab,
// group-detail page, project Members page so the precedence + sort logic
// can be unit-tested without spinning up React or a query client.
//
// Three small problems, one file:
//
//   1. Sorting + counting group members whose ACCOUNT role overrides
//      the group's project grant (super-admin > owner > admin > member).
//      Used by the Group detail → Group members warning banner.
//
//   2. Floating the current user to the top of the "Add members" picker
//      so self-add is a one-click action.
//
//   3. Labelling a project Members row that has access only via a group
//      ("Inherited Manager via Engineering + 1 more").

// ONE role model. These are re-exports of the SDK's unions, not local copies —
// this file used to declare its own `AccountRole` / `ProjectRole`, shadowing
// `@kortix/sdk`'s, so the same two names meant two things depending on the
// import path.
export type { AccountRole, ProjectRole } from '@kortix/sdk';

import type { AccountRole, ProjectRole } from '@kortix/sdk';
import { builtinRoleDescriptor } from '@/features/workspace/shared/access/role-select';

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
  return (
    meta.isSuperAdmin ||
    meta.accountRole === 'owner' ||
    meta.accountRole === 'admin'
  );
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
export function sortGroupMembersByOverride<
  T extends { user_id: string; added_at: string },
>(members: T[], metaByUserId: Map<string, AccountMeta>): T[] {
  return [...members].sort((a, b) => {
    const ra = overrideRank(metaByUserId.get(a.user_id));
    const rb = overrideRank(metaByUserId.get(b.user_id));
    if (ra !== rb) return ra - rb;
    return new Date(a.added_at).getTime() - new Date(b.added_at).getTime();
  });
}

/**
 * Return the eligible list with the current user pinned to position 0
 * if they're still eligible. No-op when the user is absent or already
 * first.
 */
export function floatCurrentUserFirst<T extends { user_id: string }>(
  eligible: T[],
  currentUserId: string | null,
): T[] {
  if (!currentUserId) return eligible;
  const idx = eligible.findIndex((m) => m.user_id === currentUserId);
  if (idx <= 0) return eligible;
  const me = eligible[idx];
  return [me, ...eligible.slice(0, idx), ...eligible.slice(idx + 1)];
}

// ─── Project Members → inherited-via-group label ─────────────────────────

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

// `formatExpiry` used to live here too — a second implementation with a
// different signature and different output from `shared/access/access-shared.ts`,
// which the barrel's own policy forbids. Deleted; use that one.

/**
 * Render the "Inherited X via Y" subtitle. Returns null when the row
 * isn't group-inherited (caller falls back to the "No access" / "Granted
 * {date}" / "Implicit account access" copy).
 */
export function inheritedFromGroupSummary(row: ProjectAccessRowInput): string | null {
  if (!isInheritedFromGroupOnly(row)) return null;
  const sources = row.group_sources!;
  const head = sources[0];
  const rest = sources.length - 1;
  // ONE source for the words: `role-select.tsx`'s descriptors, the same copy the
  // role picker and the help page render. This file used to keep a third copy.
  const label = builtinRoleDescriptor('project', row.effective_project_role!)?.label ?? 'Member';
  return rest > 0
    ? `Inherited ${label} via ${head.group_name} + ${rest} more`
    : `Inherited ${label} via ${head.group_name}`;
}
