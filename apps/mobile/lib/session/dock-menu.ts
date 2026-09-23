/**
 * dock-menu — small pure-data tables for two unrelated project surfaces.
 *
 * `DockIconKey` / `PageContextMenuSheet`: icon keys for the per-page `···`
 * context menu (`components/session/PageContextMenuSheet.tsx`) — the
 * Workspace page's New agent / New skill / New command / New project
 * prompts, and the Files page's rename/delete rows. These start an
 * agent-led session or a file action; they do not open a page.
 *
 * `PROJECT_CUSTOMIZE_ITEMS`: the project Settings page's ("page:settings",
 * `SettingsNavPage`) "Customize" group — Schedules and Secrets, the two
 * sections mobile still keeps as in-app pages. The project sheet
 * (`CustomizeSheet`, `CUSTOMIZE_SHEET_GROUPS`) that used to list every
 * section is deleted (COR-123/COR-160 Task 3): Agents, Skills, Members and
 * Terminal have no mobile page any more; Review moves into the drawer
 * (Task 4); Files stays reachable from the drawer only. Members and "More on
 * kortix.com" are web-handoff rows `SettingsNavPage` adds itself
 * (`lib/projects/web-project-links.ts`), not data here.
 *
 * Pure data only. No React, no icons, no zustand: this module is
 * unit-tested under `bun test`, which cannot load native modules. Icon keys
 * are resolved to components in `components/session/dock-icons.ts`.
 */

import type { SubPageId } from './project-stack';

export type DockIconKey =
  // page context menu rows (PageContextMenuSheet)
  | 'files' | 'settings' | 'rename' | 'delete'
  // Workspace "···" prompts (PageContextMenuSheet)
  | 'agents' | 'skills' | 'terminal'
  // project Settings page, Customize group
  | 'schedules' | 'secrets';

export interface ProjectCustomizeItem {
  kind: 'item';
  label: string;
  icon: DockIconKey;
  /** A `tab-store` page id that opens as a sub-page of project Settings. */
  pageId: SubPageId;
}

/** The project Settings page's "Customize" group: Schedules and Secrets. */
export const PROJECT_CUSTOMIZE_ITEMS: ProjectCustomizeItem[] = [
  { kind: 'item', label: 'Schedules', icon: 'schedules', pageId: 'page:schedules' },
  { kind: 'item', label: 'Secrets', icon: 'secrets', pageId: 'page:secrets-nav' },
];
