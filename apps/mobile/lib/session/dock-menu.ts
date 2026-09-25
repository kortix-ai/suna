/**
 * dock-menu — the project Settings page's ("page:settings", `SettingsNavPage`)
 * "Customize" group: Schedules, Secrets and Members, the sections mobile
 * keeps as in-app pages. Each row opens its page as a sub-page of project
 * Settings (`openSubPage`). Nothing here opens a provider or models page:
 * mobile has no models screen.
 *
 * The project sheet (`CustomizeSheet`) that used to list every section is
 * deleted (COR-123/COR-160 Task 3): Agents, Skills and Terminal have no
 * mobile page any more; Members came back as an in-app page (Jay,
 * 2026-09-24); Review is in the drawer; Files is the
 * drawer's `files` route. The per-page `···` menu (`PageContextMenuSheet`)
 * is deleted with the Workspace and Files pages it served (COR-156).
 * "More on kortix.com" is a web-handoff row `SettingsNavPage` adds itself (`lib/projects/web-project-links.ts`), not data here.
 *
 * Pure data only. No React, no icons, no zustand: this module is
 * unit-tested under `bun test`, which cannot load native modules. Icon keys
 * are resolved to components in `components/session/dock-icons.ts`.
 */

import type { SubPageId } from './project-stack';

/** The Customize group's row icons. */
export type DockIconKey = 'schedules' | 'secrets' | 'members';

export interface ProjectCustomizeItem {
  kind: 'item';
  label: string;
  icon: DockIconKey;
  /** A `tab-store` page id that opens as a sub-page of project Settings. */
  pageId: SubPageId;
}

/** The project Settings page's "Customize" group: Schedules, Secrets and Members. */
export const PROJECT_CUSTOMIZE_ITEMS: ProjectCustomizeItem[] = [
  { kind: 'item', label: 'Schedules', icon: 'schedules', pageId: 'page:schedules' },
  { kind: 'item', label: 'Secrets', icon: 'secrets', pageId: 'page:secrets-nav' },
  { kind: 'item', label: 'Members', icon: 'members', pageId: 'page:members' },
];
