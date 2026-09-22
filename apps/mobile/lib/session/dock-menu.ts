/**
 * dock-menu — the project sheet's data.
 *
 * The sheet opens from the `···` button at the right end of the header, on
 * project home and in a thread (`ProjectHeaderActions`), and from a tool
 * page's `PageHeader` "···" button (Jay, 2026-09-21).
 *
 * Group one is the project's core sections, untitled. Group two keeps every
 * other page. Connectors have no row: mobile leaves them to web. Changes has no
 * row and no other entry point: Review holds change requests, opens new ones
 * (`+`), and lists the branches (history button). Dev has no row: it is web's
 * "Develop on your own machine" guide, terminal commands for a laptop. Models opens the provider page until its own page exists.
 *
 * Pure data only. No React, no icons, no zustand: this module is
 * unit-tested under `bun test`, which cannot load native modules. Icon keys
 * are resolved to components in `components/session/dock-icons.ts`.
 */

export type DockIconKey =
  // page context menu rows (PageContextMenuSheet)
  | 'files' | 'settings' | 'rename' | 'delete'
  // project sheet, core sections
  | 'agents' | 'skills' | 'schedules' | 'review' | 'secrets'
  // project sheet, more
  | 'members' | 'terminal';

export interface DockMenuItem {
  kind: 'item';
  label: string;
  icon: DockIconKey;
  /** A `tab-store` page id — pass to `navigateToPage`. */
  pageId: string;
}

export interface CustomizeSheetGroup {
  /** Null: the group has no title (the core sections). */
  title: string | null;
  items: DockMenuItem[];
}

/** The page the Review row opens. It carries the row's badge. */
export const REVIEW_PAGE_ID = 'page:review';
/** The page the Models row opens. The Secrets page links to it ("Manage providers"). */
export const CUSTOMIZE_SHEET_GROUPS: CustomizeSheetGroup[] = [
  {
    title: null,
    items: [
      { kind: 'item', label: 'Agents', icon: 'agents', pageId: 'page:agents' },
      { kind: 'item', label: 'Skills', icon: 'skills', pageId: 'page:skills' },
      { kind: 'item', label: 'Schedules', icon: 'schedules', pageId: 'page:schedules' },
      { kind: 'item', label: 'Review', icon: 'review', pageId: REVIEW_PAGE_ID },
      { kind: 'item', label: 'Secrets', icon: 'secrets', pageId: 'page:secrets-nav' },
    ],
  },
  {
    title: 'More',
    items: [
      { kind: 'item', label: 'Files', icon: 'files', pageId: 'page:files-nav' },
      { kind: 'item', label: 'Members', icon: 'members', pageId: 'page:members' },
      { kind: 'item', label: 'Terminal', icon: 'terminal', pageId: 'page:terminal' },
    ],
  },
];
