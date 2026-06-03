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
//      ("Inherited Editor via Engineering + 1 more").

export interface AccountMeta {
  email: string | null;
  accountRole: 'owner' | 'admin' | 'member';
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

const OVERRIDE_RANK: Record<AccountMeta['accountRole'] | 'super_admin' | 'unknown', number> = {
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

type ProjectRoleValue = 'manager' | 'editor' | 'viewer';

const PROJECT_ROLE_LABEL: Record<ProjectRoleValue, string> = {
  manager: 'Manager',
  editor: 'Editor',
  viewer: 'Viewer',
};

export interface ProjectAccessRowInput {
  has_implicit_access: boolean;
  project_role: ProjectRoleValue | null;
  effective_project_role: ProjectRoleValue | null;
  group_sources?: Array<{ group_name: string; role: ProjectRoleValue }>;
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

/**
 * "Expires in 3d" / "Expires tomorrow" / "Expired" — the inline label
 * that shows up next to a time-bounded grant. Past = "Expired" (renders
 * red in the row); future = "Expires in …" (amber). Used by the project
 * Members card + the group detail's Project access card.
 */
export function formatExpiry(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) return 'Expires (unknown)';
  if (ms <= 0) return 'Expired';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `Expires in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Expires in ${hours}h`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Expires tomorrow';
  if (days < 30) return `Expires in ${days}d`;
  return `Expires ${new Date(iso).toLocaleDateString()}`;
}

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
  const label = PROJECT_ROLE_LABEL[row.effective_project_role!];
  return rest > 0
    ? `Inherited ${label} via ${head.group_name} + ${rest} more`
    : `Inherited ${label} via ${head.group_name}`;
}
