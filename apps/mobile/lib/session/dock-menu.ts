/**
 * dock-menu — the single source of truth for what the project dock can reach.
 *
 * Pure data and pure functions only. No React, no lucide, no zustand: this
 * module is unit-tested under `bun test`, which cannot load native modules.
 * Icon keys are resolved to components in `components/session/dock-icons.ts`.
 */

export type DockIconKey =
  // dock rows
  | 'files' | 'browser' | 'agents' | 'skills' | 'memory' | 'settings' | 'more'
  // more sheet
  | 'commands' | 'connectors' | 'secrets' | 'channels'
  | 'schedules' | 'webhooks' | 'terminal' | 'sandbox' | 'dev'
  | 'changes' | 'members'
  // chat actions
  | 'rename' | 'share' | 'restart' | 'export' | 'compact'
  | 'changeRequest' | 'viewChanges' | 'archive' | 'delete';

export interface DockMenuItem {
  kind: 'item';
  label: string;
  icon: DockIconKey;
  /** A `tab-store` page id — pass to `navigateToPage`. */
  pageId: string;
}

export interface DockMenuDivider {
  kind: 'divider';
}

export type DockMenuEntry = DockMenuItem | DockMenuDivider;

/**
 * The short menu the pill expands into. The trailing "More…" row is rendered
 * by ProjectDock and is intentionally absent here — it has no page id.
 *
 * Files is `page:files-nav` (FilesNavPage, project-level), NOT `page:files`
 * (FilesPage, the session sandbox browser).
 */
export const DOCK_MENU_ENTRIES: DockMenuEntry[] = [
  { kind: 'item', label: 'Files', icon: 'files', pageId: 'page:files-nav' },
  { kind: 'item', label: 'Browser', icon: 'browser', pageId: 'page:browser' },
  { kind: 'divider' },
  { kind: 'item', label: 'Agents', icon: 'agents', pageId: 'page:agents' },
  { kind: 'item', label: 'Skills', icon: 'skills', pageId: 'page:skills' },
  { kind: 'item', label: 'Memory', icon: 'memory', pageId: 'page:memory' },
  { kind: 'item', label: 'Settings', icon: 'settings', pageId: 'page:settings' },
];

export interface MoreSheetGroup {
  title: string;
  items: DockMenuItem[];
}

/** Everything the right drawer held that isn't in the dock's short menu. */
export const MORE_SHEET_GROUPS: MoreSheetGroup[] = [
  {
    title: 'Build',
    items: [{ kind: 'item', label: 'Commands', icon: 'commands', pageId: 'page:commands' }],
  },
  {
    title: 'Connect',
    items: [
      { kind: 'item', label: 'Connectors', icon: 'connectors', pageId: 'page:connectors' },
      { kind: 'item', label: 'Secrets', icon: 'secrets', pageId: 'page:secrets-nav' },
      { kind: 'item', label: 'Channels', icon: 'channels', pageId: 'page:channels-nav' },
    ],
  },
  {
    title: 'Automate',
    items: [
      { kind: 'item', label: 'Schedules', icon: 'schedules', pageId: 'page:schedules' },
      { kind: 'item', label: 'Webhooks', icon: 'webhooks', pageId: 'page:webhooks' },
    ],
  },
  {
    title: 'Advanced',
    items: [
      { kind: 'item', label: 'Terminal', icon: 'terminal', pageId: 'page:terminal' },
      { kind: 'item', label: 'Sandbox', icon: 'sandbox', pageId: 'page:sandbox' },
      { kind: 'item', label: 'Dev', icon: 'dev', pageId: 'page:dev' },
    ],
  },
  {
    title: 'Project',
    items: [
      { kind: 'item', label: 'Changes', icon: 'changes', pageId: 'page:changes' },
      { kind: 'item', label: 'Members', icon: 'members', pageId: 'page:members' },
    ],
  },
];

/** The pill names where you are: the chat in a thread, the project otherwise. */
export function dockPillLabel(args: {
  inThread: boolean;
  chatTitle?: string | null;
  projectName?: string | null;
}): string {
  if (args.inThread) return args.chatTitle?.trim() || 'New chat';
  return args.projectName?.trim() || 'Project';
}

export type ChatActionId =
  | 'rename' | 'share' | 'restart' | 'export' | 'compact'
  | 'viewChanges' | 'archive' | 'delete';

export interface ChatAction {
  id: ChatActionId;
  label: string;
  icon: DockIconKey;
  /** Rendered behind the sheet's own "More" disclosure. */
  secondary?: boolean;
  destructive?: boolean;
}

export interface ChatActionGates {
  /** A thread is open. When false there is nothing to act on. */
  hasSession: boolean;
  /** The active tab resolves to a Kortix project-session row. */
  hasProjectSession: boolean;
  /** `can_manage_sharing !== false` on that row. */
  canManageSharing: boolean;
}

/**
 * Mirrors BottomBar's original gating: Rename/Share/Delete need a resolved
 * project-session row, and Share additionally needs can_manage_sharing.
 * "Open change request" is NOT here — it lives on the dock menu itself
 * (ProjectDock's onOpenChangeRequest row), so it isn't duplicated in this sheet.
 */
export function chatActionItems(gates: ChatActionGates): ChatAction[] {
  if (!gates.hasSession) return [];

  const actions: ChatAction[] = [];

  if (gates.hasProjectSession) {
    actions.push({ id: 'rename', label: 'Rename', icon: 'rename' });
    if (gates.canManageSharing) {
      actions.push({ id: 'share', label: 'Share', icon: 'share' });
    }
  }
  actions.push({ id: 'restart', label: 'Restart', icon: 'restart' });
  actions.push({ id: 'export', label: 'Export transcript', icon: 'export' });
  actions.push({ id: 'compact', label: 'Compact', icon: 'compact' });

  actions.push({ id: 'viewChanges', label: 'View changes', icon: 'viewChanges', secondary: true });
  actions.push({ id: 'archive', label: 'Archive', icon: 'archive', secondary: true });

  if (gates.hasProjectSession) {
    actions.push({ id: 'delete', label: 'Delete', icon: 'delete', destructive: true });
  }

  return actions;
}
