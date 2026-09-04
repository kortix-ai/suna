import {
  ChatCircleIcon as ChatCircle,
  CoinsIcon as Coins,
  CreditCardIcon as CreditCard,
  KeyIcon as Key,
  LinkIcon as Link,
  PaletteIcon as Palette,
  ShieldCheckIcon as ShieldCheck,
  SlidersHorizontalIcon as SlidersHorizontal,
  UserIcon as User,
  ArrowCircleUpIcon as ArrowUpCircle,
  ShippingContainerIcon as Container,
  FlaskIcon as Flask,
  SquaresFourIcon as SquaresFour,
} from '@phosphor-icons/react';

import type { SettingsTab } from './settings-tabs';
import type { RailGroup, RailItem } from './type';

/**
 * Whether a rail item is the active one for the current settings tab.
 *
 * A plain 1:1 match. It used to carry a `models` stand-in for the seven
 * legacy `llm-*` sub-page ids, which went with the Models tab when project
 * configuration moved out of this rail. Those ids resolve through `GRADUATED`
 * in `settings-tabs.ts` onto `/projects/<id>/models` now — the config page
 * that briefly owned them was retired on 2026-09-02. Every tab left in this
 * rail matches its own id and nothing else.
 */
export function isRailItemActive(item: RailItem, tab: SettingsTab): boolean {
  return item.tab === tab;
}

const STATIC_GROUPS: readonly RailGroup[] = [
  /**
   * No Workspace group. Project configuration — General, Sandbox templates,
   * Feature flags, Upgrades — is the Customize bar's Settings tab
   * (`/projects/<id>/config`, `capability-tab-routes.ts`), where the rest of
   * the project is configured. It sat here between 2026-09-02 and
   * 2026-09-03; Marko: the overlay is for the PERSON, so it holds only what
   * is theirs — their profile and their account.
   */
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
        // "Notifications" (Marko, 2026-09-03): the pane is about how a running
        // session gets your attention, not about sessions themselves — those
        // are the sidebar. The id stays `sessions` (it is the URL segment).
        label: 'Notifications',
        description: 'How a running session gets your attention.',
        icon: ChatCircle,
      },
      {
        tab: 'preferences',
        // "Language & shortcuts", not "Preferences": the overlay itself is called
        // Preferences now (Marko, 2026-09-03), and a tab named after its own
        // dialog says nothing.
        label: 'Language & shortcuts',
        description: 'Language and keyboard shortcuts.',
        icon: SlidersHorizontal,
      },
      // Labelled "API keys", routed at `/settings/tokens`. The id has to be
      // `tokens` — it is the URL segment, and the account page already spends
      // `api-keys` on a legacy redirect (`RENAMED` in `settings-tabs.ts`) —
      // but nothing in the product calls a person's own key a "token", so the
      // row says what the thing is called. Same split as `connected`, whose id
      // is one word and whose label is two.
      {
        tab: 'tokens',
        // "Personal access keys" (Marko, 2026-09-03): these are API keys that
        // act AS YOU — the CLI, a script or a CI job signed in under your
        // identity — as opposed to the account's service-account tokens on
        // the account page. The label says whose identity they carry.
        label: 'Personal access keys',
        description: 'API keys that act as you — for the CLI, a script, or a CI job.',
        icon: Key,
      },
    ],
  },
  // No Account group either (Marko, 2026-09-03): Credits and Plan describe
  // the ORGANISATION's wallet and subscription, and every account setting
  // lives on the account page, `/accounts/[id]`. Grouping them under a
  // person's own settings claimed they were theirs. `/settings/credits` and
  // `/settings/plan` redirect there through `ACCOUNT_GRADUATED`.
];

/**
 * Rows that are no longer in the rail but whose PANES still render somewhere
 * — the four project sections on the Customize bar's Settings tab
 * (`capabilities/project-settings/`), and the two account panes an old deep
 * link can still open. `railItemForTab` resolves these too, so each pane
 * keeps the heading and description it always had; only the rail stopped
 * listing them.
 */
export const RETIRED_RAIL_ITEMS: readonly RailItem[] = [
  {
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
  {
    tab: 'upgrades',
    label: 'Upgrades',
    description:
      'Changes an agent makes to this workspace. Every run opens a change request for you to review — nothing merges on its own.',
    icon: ArrowUpCircle,
  },
  // Connected accounts listed the ACCOUNT's GitHub App installations — the
  // same rows the account page's Git tab manages — under a person's own
  // settings. Gone from the rail on 2026-09-03 (Marko); `/settings/connected`
  // redirects to that tab through `ACCOUNT_GRADUATED`.
  {
    tab: 'connected',
    label: 'Connected accounts',
    icon: Link,
  },
  {
    tab: 'credits',
    label: 'Credits',
    description: 'What this account has left to spend, and what it spent this period.',
    icon: Coins,
  },
  {
    tab: 'plan',
    label: 'Plan',
    description: 'Your subscription, team seats, and billing for this account.',
    icon: CreditCard,
  },
];


/**
 * The rail. One group — `Personal` — and no flag-gated rows. Project
 * configuration is the Customize bar's Settings tab; account configuration
 * is the account page. The overlay is the person's own settings, nothing
 * else (Marko, 2026-09-03).
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
  return RETIRED_RAIL_ITEMS.find((item) => item.tab === tab);
}
