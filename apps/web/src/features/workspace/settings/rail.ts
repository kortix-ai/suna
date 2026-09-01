import {
  KeyIcon as Key,
  LinkIcon as Link,
  SlidersHorizontalIcon as SlidersHorizontal,
  SquaresFourIcon as SquaresFour,
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
  /**
   * First, above `You`, because it is the thing you are inside. The overlay is
   * opened from a row labelled "User Settings", but that row names its
   * DEFAULT tab (`profile`), not the rail's order — so leading with Workspace
   * costs the personal tabs nothing and puts the workspace's own identity
   * where a person looks first.
   *
   * The group disappears whole when the overlay opens without a project:
   * `workspace` is absent from `ACCOUNT_SCOPED_SETTINGS_TABS`, so
   * `isSettingsTabAllowed` filters the row, and `SettingsPanel` drops any group
   * left with no items. That also restores the rail's group HEADINGS, which
   * `SettingsPanelShell` hides while there is only one group.
   */
  {
    label: 'Workspace',
    items: [
      {
        // Labelled "General", routed at `/settings/workspace` — the same
        // label/id split `tokens` ("API keys") makes below, and for the same
        // reason: the id is a URL segment that `general` had already spent on
        // a redirect, while the label is what this pane has always been called.
        tab: 'workspace',
        label: 'General',
        description: 'Name and icon for this workspace.',
        icon: SquaresFour,
      },
    ],
  },
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
      // Labelled "API keys", routed at `/settings/tokens`. The id has to be
      // `tokens` — it is the URL segment, and the account page already spends
      // `api-keys` on a legacy redirect (`RENAMED` in `settings-tabs.ts`) —
      // but nothing in the product calls a person's own key a "token", so the
      // row says what the thing is called. Same split as `connected`, whose id
      // is one word and whose label is two.
      {
        tab: 'tokens',
        label: 'API keys',
        description: 'Keys that sign the CLI, a script, or a CI job in as you.',
        icon: Key,
      },
    ],
  },
  // The 'Agent' group is gone, and 'Developer' went with it once Feature flags
  // (the old `experimental` row) left too. Every one of those rows configured a
  // PROJECT, and the Customize bar already gates on exactly the person allowed
  // to change them — so they live on that bar now, at `/projects/<id>/config`
  // (`capabilities/project-settings/`). Do not re-add them as settings tabs;
  // `GRADUATED` in `settings-tabs.ts` carries every bookmark to the section
  // that replaced it.
  //
  // 'Workspace' came BACK on 2026-09-01, and only its General row did — see
  // the group above and `SettingsTab`'s own note for why that one row is not
  // configuration in the sense the rest of this paragraph means. The rule
  // still holds for everything else that left.
  //
  // The 'Organization' group is gone for a different reason, recorded above
  // its own removal: those rows configured the ACCOUNT and moved to
  // `/accounts/[id]`.
];

/**
 * The rail. Two groups — `Workspace` and `You` — and no flag-gated rows in
 * either. `Workspace` is filtered out entirely when the overlay opens without a
 * project, so the rail is back to one group there.
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
