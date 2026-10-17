/**
 * dock-menu — the project Settings page's ("page:settings", `SettingsNavPage`)
 * "Customize" group: Schedules, Secrets, Members (in-app pages) and
 * Connectors (a web hand-off, KRTX-249). Each `kind: 'item'` row opens its
 * page as a sub-page of project Settings (`openSubPage`). The `kind:
 * 'web-handoff'` row (Connectors) has no `pageId` — `SettingsNavPage` opens
 * a `WebHandoffSheet` instead, whose Continue runs the connectors web flow.
 * Nothing here opens a provider or models page: mobile has no models screen.
 *
 * The project sheet (`CustomizeSheet`) that used to list every section is
 * deleted (COR-123/COR-160 Task 3): Agents, Skills and Terminal have no
 * mobile page any more; Members came back as an in-app page (Jay,
 * 2026-09-24); Review is in the drawer; Files is the
 * drawer's `files` route. Connectors moved here from the project drawer's
 * `NavPill` (KRTX-249) — mobile still has no connector catalog, so it is
 * still a web hand-off, just reached from Customize instead of the drawer.
 * The per-page `···` menu (`PageContextMenuSheet`) is deleted with the
 * Workspace and Files pages it served (COR-156).
 * "More on kortix.com" is a web-handoff row `SettingsNavPage` adds itself directly (`lib/projects/web-project-links.ts`), not data here.
 *
 * Pure data only. No React, no icons, no zustand: this module is
 * unit-tested under `bun test`, which cannot load native modules. Icon keys
 * are resolved to components in `components/session/dock-icons.ts`.
 */

import type { SubPageId } from './project-stack';
import {
  CONNECTORS_ACCESS,
  MEMBERS_ACCESS,
  SCHEDULES_ACCESS,
  SECRETS_ACCESS,
  navAccessAllowed,
  type NavAccess,
} from './nav-access';

/** The Customize group's row icons. */
export type DockIconKey = 'schedules' | 'secrets' | 'members' | 'connectors';

/** A Customize row that pushes an in-app sub-page of project Settings. */
export interface ProjectCustomizePushItem {
  kind: 'item';
  label: string;
  icon: DockIconKey;
  /** The IAM leaves that make the row worth showing (`nav-access.ts`). */
  access: NavAccess;
  /** A `tab-store` page id that opens as a sub-page of project Settings. */
  pageId: SubPageId;
}

/**
 * A Customize row that opens a `WebHandoffSheet` instead of a sub-page —
 * Connectors (KRTX-249): mobile has no connector catalog, so Continue opens
 * the connectors web flow in an in-app auth session.
 */
export interface ProjectCustomizeHandoffItem {
  kind: 'web-handoff';
  label: string;
  icon: DockIconKey;
  access: NavAccess;
}

export type ProjectCustomizeItem = ProjectCustomizePushItem | ProjectCustomizeHandoffItem;

/**
 * The project Settings page's "Customize" group: Schedules, Secrets, Members,
 * then Connectors — in that order, right above "More on kortix.com".
 */
export const PROJECT_CUSTOMIZE_ITEMS: ProjectCustomizeItem[] = [
  { kind: 'item', label: 'Schedules', icon: 'schedules', pageId: 'page:schedules', access: SCHEDULES_ACCESS },
  { kind: 'item', label: 'Secrets', icon: 'secrets', pageId: 'page:secrets-nav', access: SECRETS_ACCESS },
  { kind: 'item', label: 'Members', icon: 'members', pageId: 'page:members', access: MEMBERS_ACCESS },
  { kind: 'web-handoff', label: 'Connectors', icon: 'connectors', access: CONNECTORS_ACCESS },
];

/** The rows the caller may open, from the `useCans` verdicts. Empty until they land. */
export function visibleCustomizeItems(cans: Parameters<typeof navAccessAllowed>[0]): ProjectCustomizeItem[] {
  return PROJECT_CUSTOMIZE_ITEMS.filter((item) => navAccessAllowed(cans, item.access));
}
