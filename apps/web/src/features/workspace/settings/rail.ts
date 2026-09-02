import {
  ArrowCircleUpIcon as ArrowUpCircle,
  ChatCircleIcon as ChatCircle,
  ShippingContainerIcon as Container,
  CreditCardIcon as CreditCard,
  FlaskIcon as Flask,
  KeyIcon as Key,
  LinkIcon as Link,
  PaletteIcon as Palette,
  ShieldCheckIcon as ShieldCheck,
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
   * First, above the personal groups, because it is the thing you are inside.
   * The group disappears whole when the overlay opens without a project:
   * none of its tabs is in `ACCOUNT_SCOPED_SETTINGS_TABS`, so
   * `isSettingsTabAllowed` filters every row and `SettingsPanel` drops the
   * empty group.
   *
   * This group IS project configuration now: `/projects/<id>/config` was
   * retired on 2026-09-02 and every section of it that configures the
   * project lives here. (Review, the one section that was an inbox, is a
   * capability tab instead — `capability-tab-routes.ts`.)
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
      {
        tab: 'sandbox',
        label: 'Sandbox templates',
        // Sandbox templates AND Snapshots — a snapshot is the build history of
        // a sandbox template, not a separate concept, so one row shows the
        // template's recipe and the record of each time Kortix built a
        // machine from it.
        description:
          'The recipe for the machine a session runs on, and the record of every time Kortix prepared one.',
        docsHref: '/docs/work/runtime',
        icon: Container,
      },
      {
        tab: 'feature-flags',
        label: 'Feature flags',
        description: 'Features you can switch on before they are generally available.',
        icon: Flask,
      },
      // Last, where the old rail pinned it. Not billing: the agent-driven
      // upgrade runner, which opens a change request against this workspace's
      // own repo. Moved here from `/projects/<id>/config` on 2026-09-02.
      {
        tab: 'upgrades',
        label: 'Upgrades',
        description:
          'Changes an agent makes to this workspace. Every run opens a change request for you to review — nothing merges on its own.',
        icon: ArrowUpCircle,
      },
    ],
  },
  {
    // "Personal", not "You" (Jay, 2026-09-02): the group names the scope the
    // same way "Workspace" and "Account" do.
    label: 'Personal',
    items: [
      {
        tab: 'profile',
        label: 'Profile',
        description: 'Your picture, name, email, and organizations.',
        icon: User,
      },
      {
        tab: 'security',
        label: 'Security',
        description: 'Two-factor authentication and the devices signed in as you.',
        icon: ShieldCheck,
      },
      {
        tab: 'appearance',
        label: 'Appearance',
        description: 'Theme, wallpaper, and how much a conversation shows.',
        icon: Palette,
      },
      {
        tab: 'sessions',
        label: 'Sessions',
        description: 'How a running session gets your attention.',
        icon: ChatCircle,
      },
      {
        tab: 'preferences',
        label: 'Preferences',
        description: 'Language and keyboard shortcuts.',
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
  {
    label: 'Account',
    items: [
      {
        tab: 'plan',
        label: 'Plan',
        description: 'Your subscription, credits, and billing for this account.',
        icon: CreditCard,
      },
    ],
  },
  // The 'Agent' group is gone, and 'Developer' went with it. Every one of
  // those rows configured a PROJECT, and the Customize bar gates on exactly the
  // person allowed to change them — so they live on that bar, at
  // `/projects/<id>/config` (`capabilities/project-settings/`). Two of them —
  // Sandbox templates and Feature flags — came BACK on 2026-09-02 as a second
  // door onto the same components; `GRADUATED` in `settings-tabs.ts` still
  // carries every bookmark to the config page.
  //
  // The 'Organization' group is gone for a different reason, recorded above
  // its own removal: those rows configured the ACCOUNT and moved to
  // `/accounts/[id]`. `Plan` above is the one account row that came back.
];

/**
 * The rail. Three groups — `Workspace`, `Personal`, `Account` — and no
 * flag-gated rows in any. `Workspace` is filtered out entirely when the
 * overlay opens without a project.
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
