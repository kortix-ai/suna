import {
  LinkIcon as Link,
  SlidersHorizontalIcon as SlidersHorizontal,
  UserIcon as User,
} from '@phosphor-icons/react';
import type { SettingsTab } from './settings-tabs';
import type { RailGroup, RailItem } from './type';

/**
 * Whether a rail item is the active one for the current settings tab.
 *
 * A plain 1:1 match. It used to carry a `models` stand-in for the seven
 * legacy `llm-*` sub-page ids, which went with the Models tab when project
 * configuration moved to `/projects/<id>/config` — the sub-nav there resolves
 * those ids itself (see
 * `capabilities/project-settings/project-settings-page.tsx`). Every tab left
 * in this rail matches its own id and nothing else.
 */
export function isRailItemActive(item: RailItem, tab: SettingsTab): boolean {
  return item.tab === tab;
}

const STATIC_GROUPS: readonly RailGroup[] = [
  {
    label: 'You',
    items: [
      {
        tab: 'profile',
        label: 'Profile',
        icon: User,
      },
      {
        tab: 'preferences',
        label: 'Preferences',
        icon: SlidersHorizontal,
      },
      {
        tab: 'connected',
        label: 'Connected accounts',
        icon: Link,
      },
    ],
  },
  // The 'Workspace' and 'Agent' groups are gone, and 'Developer' went with
  // them once Feature flags (the old `experimental` row) left too. Every one
  // of those rows configured a PROJECT, and the Customize bar already gates on
  // exactly the person allowed to change them — so they live on that bar now,
  // at `/projects/<id>/config` (`capabilities/project-settings/`). Do not
  // re-add them as settings tabs; `GRADUATED` in `settings-tabs.ts` carries
  // every bookmark to the section that replaced it.
  //
  // The 'Organization' group is gone for a different reason, recorded above
  // its own removal: those rows configured the ACCOUNT and moved to
  // `/accounts/[id]`.
];

/**
 * The rail. One group — `You` — and no flag-gated rows left in it.
 *
 * It took a `RailFlags` argument until Marketplace, Review and Voice moved to
 * the Customize bar's Settings tab with the rest of project configuration
 * (`capabilities/project-settings/project-settings-sections.ts` owns the
 * flag composition now). Nothing here varies by flag any more, so nothing
 * here takes one — a parameter that no branch reads is a lie about what the
 * caller controls.
 *
 * Still a function, not a bare constant: `settings-panel.tsx` and the command
 * palette both call it, and a group that reappears here (or one that becomes
 * conditional again) must not change either call site's shape.
 */
export function railGroups(): readonly RailGroup[] {
  return STATIC_GROUPS;
}

/*
 * `railItemMatches` and `filterRailGroups` used to live here: the rail carried
 * its own "Search settings" field, which narrowed the groups as you typed.
 *
 * Both are gone with the field. A filter over THREE rows, all of them visible
 * at once with no scrolling, cannot narrow anything a person could not already
 * see — it was written when the rail was 28 rows across four groups. The
 * search that survives is the command palette's, which is strictly better at
 * this size: it is derived from these same groups
 * (`settings-palette-items.ts`), it is reachable without opening the dialog
 * first, and it matches on group label and keywords too.
 *
 * Deleted rather than left exported-but-unused, so nothing here claims a
 * capability the UI does not offer.
 */

/**
 * The `RailItem` for a tab.
 *
 * Returns `undefined` for a tab with no rail row, so callers must handle
 * absence rather than assume a row exists — `SettingsTabHeader` renders
 * nothing at all in that case, and the project-configuration tabs that left
 * this rail are resolved by
 * `capabilities/project-settings/project-settings-sections.ts` instead.
 */
export function railItemForTab(tab: SettingsTab): RailItem | undefined {
  for (const group of STATIC_GROUPS) {
    const found = group.items.find((item) => item.tab === tab);
    if (found) return found;
  }
  return undefined;
}
