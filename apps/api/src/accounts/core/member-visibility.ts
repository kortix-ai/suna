/**
 * The member DIRECTORY (who is in the account — email, role, group names) is
 * visible to EVERY member of the account, the way Slack / GitHub / Notion show
 * teammates within one company. But one member's SECURITY POSTURE is not
 * something every teammate should see.
 *
 * `canSeeSensitiveMemberColumns` decides who may see the sensitive per-member
 * columns — active PAT count, verified-MFA flag, group memberships, and explicit
 * project grants: only member-managers (owners/admins, or anyone granted
 * `member.invite`) and the viewer's OWN row.
 *
 * Pure and dependency-free so it can be unit-tested in isolation.
 */
export function canSeeSensitiveMemberColumns(
  viewerUserId: string,
  rowUserId: string,
  canManageMembers: boolean,
): boolean {
  return canManageMembers || viewerUserId === rowUserId;
}
