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

import type { ProjectRole, AccountRole } from '@/lib/projects-client';

interface ProjectRoleDescriptor {
  /** "Manager" — what the role is called everywhere. */
  label: string;
  /** One-liner used directly under the role label in dropdowns. */
  blurb: string;
  /** Two-sentence version for popovers / tooltips. */
  summary: string;
}

export const PROJECT_ROLE_DESCRIPTORS: Record<ProjectRole, ProjectRoleDescriptor> = {
  viewer: {
    label: 'Viewer',
    blurb: 'Read-only. See the project, sessions, triggers, and members.',
    summary:
      'Can open the project and read its sessions, triggers, and member list. Cannot edit anything, run sessions, or change settings.',
  },
  editor: {
    label: 'Editor',
    blurb: 'Everything a viewer sees, plus edit the project and run sessions.',
    summary:
      'Everything a viewer can do, plus edit the project, deploy, start/stop sessions, and create or fire triggers. Cannot invite members or change project settings.',
  },
  manager: {
    label: 'Manager',
    blurb: 'Full control — edit the project, invite members, change settings.',
    summary:
      'Everything an editor can do, plus invite or remove project members, change member roles, and delete the project.',
  },
};

/** Ordered low → high. Useful for rendering dropdowns consistently. */
export const PROJECT_ROLES_ASCENDING: ProjectRole[] = ['viewer', 'editor', 'manager'];

interface AccountRoleDescriptor {
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
