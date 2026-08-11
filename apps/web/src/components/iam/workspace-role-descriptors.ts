// Single source of truth for how workspace roles are described in the UI.
//
// Marko's feedback: "No understanding of Viewer/Editor/Manager role in a
// project. What does a viewer in a workspace do?" — fair. The labels alone
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

import type { AccountRole, WorkspaceRole } from '@kortix/sdk';

export interface WorkspaceRoleDescriptor {
  /** "Manager" — what the role is called everywhere. */
  label: string;
  /** One-liner used directly under the role label in dropdowns. */
  blurb: string;
  /** Two-sentence version for popovers / tooltips. */
  summary: string;
}

export const WORKSPACE_ROLE_DESCRIPTORS: Record<WorkspaceRole, WorkspaceRoleDescriptor> = {
  member: {
    label: 'Member',
    blurb: 'Read + run sessions and chat, plus fire the workspace’s triggers.',
    summary:
      'The floor role for using the workspace: read everything, run sessions, chat with the agent, and fire its triggers on demand. Can’t edit, deploy, change config, or manage members.',
  },
  editor: {
    label: 'Editor',
    blurb: 'Everything a member does, plus edit and customize the workspace.',
    summary:
      'Everything a member can do, plus edit the workspace, deploy, and create or delete triggers. Cannot invite members, change member roles, or delete the workspace.',
  },
  manager: {
    label: 'Manager',
    blurb: 'Full control — edit the workspace, invite members, change settings.',
    summary:
      'Everything an editor can do, plus invite or remove workspace members, change member roles, and delete the workspace.',
  },
};

/** Ordered low → high. Useful for rendering dropdowns consistently. */
export const WORKSPACE_ROLES_ASCENDING: WorkspaceRole[] = ['member', 'editor', 'manager'];

export interface AccountRoleDescriptor {
  label: string;
  blurb: string;
}

export const ACCOUNT_ROLE_DESCRIPTORS: Record<AccountRole, AccountRoleDescriptor> = {
  owner: {
    label: 'Owner',
    blurb: 'Full control. Can transfer ownership, delete the account, and manage billing.',
  },
  admin: {
    label: 'Admin',
    blurb: 'Everything except deleting the account or transferring ownership.',
  },
  member: {
    label: 'Member',
    blurb:
      "No implicit workspace access. Sees only workspaces they've been added to (directly or via a group).",
  },
};
