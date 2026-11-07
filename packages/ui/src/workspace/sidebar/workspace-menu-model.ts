/**
 * The rows of the workspace menu (the sidebar's workspace name, Slack's
 * "Acme ▾"), in order, by group (design.md §3.1 finding 21):
 *
 *  1. the workspace header (icon, name, the caller's role);
 *  2. Invite people to {name} · Workspace settings;
 *  3. Switch workspace (the list, with the pending-invitation count) · Create workspace;
 *  4. Inbox (the person's notifications from every workspace, KRTX-1742) ·
 *     Preferences (the person's own settings; Mod+,) · Apps and extensions ·
 *     Appearance · Help · Download app;
 *  5. Leave {name} · Log out.
 *
 * Each gated row follows the gate its target applies, so a row never opens a
 * page that refuses the caller.
 */
export type WorkspaceMenuRow =
  | 'header'
  | 'invite'
  | 'settings'
  | 'switch'
  | 'create'
  | 'inbox'
  | 'preferences'
  | 'apps'
  | 'appearance'
  | 'help'
  | 'download'
  | 'leave'
  | 'logout';

export interface WorkspaceMenuGates {
  /** `project.members.manage`: the Members section's invite. */
  canInvite: boolean;
  /** Customize › Workspace settings' gate (`config`). */
  canOpenSettings: boolean;
  /** `canCreateWorkspace`: not a self-host that restricts account creation. */
  canCreate: boolean;
  /** Not the last owner (`useLeaveWorkspace`). */
  canLeave: boolean;
  /** The host serves an Inbox page (`useInboxSummary(...).href` is set). */
  hasInbox: boolean;
}

/** The menu's groups, top to bottom; a separator sits between two non-empty groups. */
export function workspaceMenuGroups(gates: WorkspaceMenuGates): WorkspaceMenuRow[][] {
  const groups: WorkspaceMenuRow[][] = [
    ['header'],
    [...(gates.canInvite ? (['invite'] as const) : []), ...(gates.canOpenSettings ? (['settings'] as const) : [])],
    ['switch', ...(gates.canCreate ? (['create'] as const) : [])],
    [...(gates.hasInbox ? (['inbox'] as const) : []), 'preferences', 'apps', 'appearance', 'help', 'download'],
    [...(gates.canLeave ? (['leave'] as const) : []), 'logout'],
  ];
  return groups.filter((group) => group.length > 0);
}
