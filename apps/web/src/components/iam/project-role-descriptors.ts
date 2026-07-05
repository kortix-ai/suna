// Single source of truth for how project roles are described in the UI.
//
// Marko's feedback: "No understanding of Viewer/Editor/Manager role in a
// project. What does a viewer in a project do?" — fair. The labels alone
// don't tell you anything, and we used to scatter the explanation across
// a help popover, a tooltip, and developer documentation. This file
// collapses that into one descriptor per role so every Select, popover,
// and badge pulls from the same copy.
//
// Keep the `blurb` short enough to fit under a Select option (one line on
// a 320px dropdown). Use `summary` for popovers / longer surfaces.
//
// The capability lists below mirror the role → action mapping in
// apps/api/src/iam/role-perms.ts. If you change one, change the other.

import type { ProjectRole, AccountRole } from '@kortix/sdk/projects-client';

export interface ProjectRoleDescriptor {
  /** "Manager" — what the role is called everywhere. */
  label: string;
  /** One-liner used directly under the role label in dropdowns. */
  blurb: string;
  /** Two-sentence version for popovers / tooltips. */
  summary: string;
}

export const PROJECT_ROLE_DESCRIPTORS: Record<ProjectRole, ProjectRoleDescriptor> = {
  member: {
    label: 'Member',
    blurb: 'Read + run sessions and chat, plus fire the project’s triggers.',
    summary:
      'The floor role for using the project: read everything, run sessions, chat with the agent, and fire its triggers on demand. Can’t edit, deploy, or change config.',
  },
  editor: {
    label: 'Editor',
    blurb: 'Everything a member does, plus edit and customize the project.',
    summary:
      'Everything a member can do, plus edit the project, deploy, and manage triggers. Inviting members, managing gateway keys, and deleting the project are account owner/admin actions, not a project role.',
  },
};

/** Ordered low → high. Useful for rendering dropdowns consistently.
 *  `manager` (the former top project role) was retired — `editor` is now the
 *  top project role. Its former exclusive powers (delete / members.manage /
 *  gateway.keys.manage) moved to account owner/admin authority. */
export const PROJECT_ROLES_ASCENDING: ProjectRole[] = ['member', 'editor'];

export interface AccountRoleDescriptor {
  label: string;
  blurb: string;
}

export const ACCOUNT_ROLE_DESCRIPTORS: Record<AccountRole, AccountRoleDescriptor> = {
  owner: {
    label: 'Owner',
    blurb:
      'Full control. Can transfer ownership, delete the account, and manage billing.',
  },
  admin: {
    label: 'Admin',
    blurb:
      'Everything except deleting the account or transferring ownership.',
  },
  member: {
    label: 'Member',
    blurb:
      'No implicit project access. Sees only projects they\'ve been added to (directly or via a group).',
  },
};
