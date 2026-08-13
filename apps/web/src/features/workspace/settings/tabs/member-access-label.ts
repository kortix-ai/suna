// Pure label logic for the unified Members table (`members-tab.tsx`) — no
// hooks, no React, testable directly with bun:test (see
// `member-access-label.test.ts`).
//
// `ProjectAccessMember` (`GET /projects/:id/access`,
// `packages/sdk/src/core/rest/projects-client/access.ts:12`) already carries
// `effective_project_role` + `effective_source` + `group_sources` computed
// server-side — this function only turns that into copy, it does not
// re-derive precedence itself.

import type { ProjectAccessMember } from '@kortix/sdk';

export interface MemberAccessLabel {
  /** "Manager" / "Editor" / "Member" / "—" (no access). Capitalizes
   *  whatever role string the server sends rather than looking it up in a
   *  fixed 3-entry table, so an unrecognized-but-string-shaped role still
   *  renders instead of falling back to nothing. */
  role: string;
  /** Annotation explaining WHY they have that role — "account admin" for
   *  implicit access, "via <group>" for a group grant, or null for a
   *  direct grant (no annotation needed) or no access ("no access"). */
  via: string | null;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function memberAccessLabel(member: ProjectAccessMember): MemberAccessLabel {
  if (!member.effective_project_role) {
    return { role: '—', via: 'no access' };
  }

  const role = capitalize(member.effective_project_role);

  if (member.effective_source === 'implicit') {
    return { role, via: 'account admin' };
  }

  if (member.effective_source === 'group') {
    // Server sorts `group_sources` by role desc (access.ts:24) — the first
    // entry is the group that actually produced `effective_project_role`.
    const groupName = member.group_sources?.[0]?.group_name;
    return { role, via: groupName ? `via ${groupName}` : null };
  }

  // 'direct', or an unrecognized/undefined source with a resolved role —
  // no annotation.
  return { role, via: null };
}
