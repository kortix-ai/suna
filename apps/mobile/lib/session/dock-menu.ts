/**
 * dock-menu — the "More…" sheet's data.
 *
 * The project dock itself was removed (nothing replaced it: no floating menu
 * button, no long-press sheet trigger, from project home or a thread). The
 * chat-actions sheet that used to share this module was also removed — its
 * only trigger was the dock's long-press, and it had no other opener.
 *
 * This module survives because `ProjectMoreSheet` and `PageContextMenuSheet`
 * still consume its data.
 *
 * Pure data only. No React, no icons, no zustand: this module is
 * unit-tested under `bun test`, which cannot load native modules. Icon keys
 * are resolved to components in `components/session/dock-icons.ts`.
 */

export type DockIconKey =
  // dock rows still used elsewhere (PageContextMenuSheet)
  | 'files' | 'agents' | 'skills' | 'settings' | 'rename' | 'delete'
  // more sheet
  | 'commands' | 'connectors' | 'secrets' | 'channels'
  | 'schedules' | 'webhooks' | 'terminal' | 'sandbox' | 'dev'
  | 'changes' | 'members';

export interface DockMenuItem {
  kind: 'item';
  label: string;
  icon: DockIconKey;
  /** A `tab-store` page id — pass to `navigateToPage`. */
  pageId: string;
}

export interface MoreSheetGroup {
  title: string;
  items: DockMenuItem[];
}

/** Everything the old right drawer held, opened from a tool page's "···" button. */
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
