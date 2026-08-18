/**
 * The command palette's Settings entries, DERIVED from the settings rail.
 *
 * **Why derived.** The palette used to carry a hand-written parallel list of
 * settings destinations in `lib/menu-registry.ts` (`proj-secrets`, `proj-git`,
 * `pref-appearance`, `account-tokens`, …). A hand-written list drifts, and it
 * did: nine of the twenty-six `SettingsTab` ids had no palette entry at all
 * (profile, connected, snapshots, groups, roles, identity, audit,
 * experimental, upgrades), `pref-general`'s "profile name email" keywords
 * opened the project WORKSPACE General tab, and `proj-llm` hid the Models row
 * behind `llm_gateway` even though `rail.ts` documents that the Models row is
 * deliberately ungated. Reading `railGroups()` — the same function the rail
 * and every pane heading already read — makes "a tab exists" and "the palette
 * can reach it" one fact instead of two.
 *
 * **What is NOT derived.** Search keywords. A `RailItem` carries `label` and
 * `description`, which are pane copy, not query terms: nobody types
 * "The recipe for the machine a session runs on". `TAB_KEYWORDS` below is the
 * palette's own vocabulary, and it is a total `Record<SettingsTab, string>` on
 * purpose — adding a tab to `SETTINGS_TABS` fails the typecheck here until it
 * is given search terms, so a new tab can never ship findable-by-label-only.
 *
 * **Why the two constants below are mirrored rather than imported.**
 * `ACCOUNT_SCOPED_SETTINGS_TABS` lives in `settings/settings-panel.tsx` and
 * `STANDALONE_DEFAULT_SETTINGS_TAB` in `settings/standalone-settings-route.tsx`.
 * Importing either one drags the whole settings tab tree (`MarketplaceView`,
 * `ScheduleView`, twenty-odd tab modules) into the command-palette chunk —
 * including on `/accounts/**`, where the palette mounts and the panel never
 * does. `settings-palette-items.test.ts`-style pinning happens instead:
 * `command-palette.test.tsx` imports the real constants and asserts these are
 * identical, so a divergence fails a test rather than shipping.
 */

import { GearSixIcon } from '@phosphor-icons/react';

import { railGroups } from '@/features/workspace/settings/rail';
import type { SettingsTab } from '@/features/workspace/settings/settings-tabs';
import type { RailItem } from '@/features/workspace/settings/type';

/**
 * Mirrors `ACCOUNT_SCOPED_SETTINGS_TABS` (settings-panel.tsx) — the tabs that
 * render without a project. See this file's header for why it is a mirror.
 */
export const PALETTE_ACCOUNT_SCOPED_TABS: readonly SettingsTab[] = [
  'profile',
  'preferences',
  'connected',
];

/**
 * Mirrors `STANDALONE_DEFAULT_SETTINGS_TAB` (standalone-settings-route.tsx).
 * The tab a settings destination with no named tab resolves to when there is
 * no project. It equals `DEFAULT_SETTINGS_TAB` today — every tab left in the
 * overlay is user-scoped, so the "no project" case no longer picks a
 * different destination — and stays a separate constant because the two
 * answer different questions and a future project-scoped tab would split them
 * again.
 */
export const PALETTE_NO_PROJECT_DEFAULT_TAB: SettingsTab = 'profile';

/**
 * Query terms per tab, on top of the rail's `label` and `description`.
 *
 * **The rule.** A word belongs on a tab only when it NAMES THAT TAB — a
 * synonym, an alias, or something the tab itself contains. A word that names a
 * DIFFERENT row's subject is a defect: it answers a query this row is the
 * wrong answer to. Ask "if a user typed this word, is this tab a correct
 * answer?" before adding one.
 *
 * **The `project customize` tail is gone.** Twelve bags used to end in it,
 * carried over verbatim from the old `Customize · X` registry entries, so
 * "customize" returned twelve settings tabs plus five navigation rows and
 * "project" returned twelve tabs that are not the Projects page. `customize`
 * survives on exactly one row here — `general`, the Workspace tab that
 * `proj-customize`'s href actually opens (`/projects/{id}/settings/general`) —
 * so the legacy word still lands on the legacy destination and nowhere else.
 * `project` survives only inside `general`'s phrase "project settings", the
 * pane's own former name.
 *
 * Four further corrections rather than straight carry-overs:
 *
 *   - `snapshot` moved off `sandbox` (it was `proj-sandbox`'s keyword) onto
 *     `snapshots`, which is the tab that word names. Typing "snapshot" used
 *     to reach Sandbox templates and could not reach Snapshots at all.
 *   - `profile name email` moved off the workspace `general` tab (they were
 *     `pref-general`'s keywords, pointing at the wrong of the app's three
 *     Generals) onto `profile`.
 *   - `keys` left `preferences` (it meant keyboard keys; `keyboard hotkeys
 *     keybindings` already say that) because it is the subject word of the
 *     `api-keys` tab.
 *   - `sso` left `organization` and `log record` left `snapshots`: `identity`
 *     is the tab that configures SSO and `audit` is the tab that is a log.
 */
const TAB_KEYWORDS: Record<SettingsTab, string> = {
  profile: 'profile name email avatar personal you account display',
  preferences:
    'preferences appearance theme color mode dark light wallpaper shader shaders background sounds audio volume notification sound effects mute shortcuts keyboard hotkeys keybindings',
  connected: 'connected accounts linked oauth google github identities social sign in providers',
  // Every other bag is gone with the tab it named. Thirteen project-
  // configuration tabs (General, Members, Secrets, Channels, Repositories,
  // Models, Sandbox templates, Snapshots, Marketplace, Review, Voice, Feature
  // flags, Upgrades) moved to `/projects/<id>/config`, and eight
  // account-scoped ones to `/accounts/[id]`. Their words moved with them, onto
  // the `proj-settings` and `account-*` rows in `lib/menu-registry.ts` — the
  // same place every other out-of-overlay destination is searched from. A tab
  // that no longer exists must not be searchable here;
  // `Record<SettingsTab, ...>` enforces that, so re-adding any key fails the
  // typecheck.
};

export interface SettingsPaletteItem {
  /** Stable cmdk/React key. Namespaced so it can never collide with a `menuRegistry` id. */
  id: string;
  tab: SettingsTab;
  label: string;
  description?: string;
  icon: NonNullable<RailItem['icon']>;
  /** The rail group this row belongs to — rendered as the palette group heading. */
  groupLabel: string;
  /** Everything the row is searchable by: label, description, and `TAB_KEYWORDS`. */
  keywords: string;
}

export interface SettingsPaletteGroup {
  label: string;
  items: SettingsPaletteItem[];
}

export interface SettingsPaletteParams {
  /** True only where `SettingsPanel` is mounted — see `openSettingsTab` in command-palette.tsx. */
  hasProject: boolean;
  // `flags: RailFlags` used to sit here. Marketplace, Review and Voice were
  // the only flag-gated rows and all three moved to `/projects/<id>/config`,
  // whose own sub-nav composes them
  // (`capabilities/project-settings/project-settings-sections.ts`). Nothing
  // left in this rail varies by flag, so `railGroups()` takes none either.
}

/**
 * Whether the palette may offer a tab at all.
 *
 * Mirrors the one flag-free clause of `isSettingsTabAllowed`
 * (settings-panel.tsx): a project-scoped tab is unreachable without a project.
 * The `billingEnabled` clause that used to sit beside it is gone with the
 * Billing tab, which now lives on `/accounts/[id]`. The remaining clause in
 * that function is an IAM probe keyed off `GATED_TAB_SECTION`, which is
 * module-private to `settings-panel.tsx`; the panel itself fail-opens on it
 * until it resolves and falls back to a visible tab when it denies, so an
 * offered-then-denied tab lands on a real pane rather than on nothing.
 */
export function isSettingsTabOfferable(tab: SettingsTab, params: SettingsPaletteParams): boolean {
  if (!params.hasProject && !PALETTE_ACCOUNT_SCOPED_TABS.includes(tab)) return false;
  return true;
}

function toPaletteItem(item: RailItem, groupLabel: string): SettingsPaletteItem {
  return {
    id: `settings-tab-${item.tab}`,
    tab: item.tab,
    label: item.label,
    description: item.description,
    icon: item.icon ?? GearSixIcon,
    groupLabel,
    keywords: [item.label, item.description ?? '', TAB_KEYWORDS[item.tab], 'settings'].join(' '),
  };
}

/**
 * Every settings tab this user can reach, grouped exactly as the rail groups
 * it. Groups that lose all their rows disappear whole, so the palette never
 * renders an empty heading.
 *
 * `UPGRADE_ITEM` used to be appended to the last group here. It left the rail
 * with the rest of project configuration and is a section of
 * `/projects/<id>/config` now, reached through the `proj-settings` registry
 * row like every other out-of-overlay destination.
 */
export function settingsPaletteGroups(params: SettingsPaletteParams): SettingsPaletteGroup[] {
  const groups: SettingsPaletteGroup[] = [];
  for (const group of railGroups()) {
    const items: SettingsPaletteItem[] = [];
    for (const item of group.items) {
      if (isSettingsTabOfferable(item.tab, params)) items.push(toPaletteItem(item, group.label));
    }
    if (items.length > 0) groups.push({ label: group.label, items });
  }
  return groups;
}

/**
 * Everything a settings row is searchable by, and the ONLY thing it is
 * searchable by. Label, rail group heading, and curated keywords — all three
 * are text the user has read on screen. `item.tab` used to be in here and is
 * not any more: it is an internal slug (`api-keys`, `review`), and matching on
 * it means matching on a string the user has never seen. Every slug's own word
 * already appears in its `TAB_KEYWORDS` bag, so nothing became unfindable.
 *
 * `command-palette.tsx` builds the cmdk `value` from exactly these fields, so
 * the manual pre-filter and cmdk's own scorer read the same text.
 */
export function settingsPaletteSearchText(item: SettingsPaletteItem): string {
  return `${item.label} ${item.groupLabel} ${item.keywords}`;
}

/**
 * One row against one query, using the palette's own rule: every whitespace-
 * separated word must appear somewhere in the row's text. `groupLabel` is part
 * of that text, so typing "organization" keeps the whole Organization group —
 * the same affordance `filterRailGroups` gives the rail.
 */
export function settingsPaletteItemMatches(item: SettingsPaletteItem, words: string[]): boolean {
  const haystack = settingsPaletteSearchText(item).toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** The grouped list narrowed to a query, with empty groups dropped. */
export function filterSettingsPaletteGroups(
  groups: SettingsPaletteGroup[],
  query: string,
): SettingsPaletteGroup[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return groups;
  const filtered: SettingsPaletteGroup[] = [];
  for (const group of groups) {
    const items = group.items.filter((item) => settingsPaletteItemMatches(item, words));
    if (items.length > 0) filtered.push({ label: group.label, items });
  }
  return filtered;
}
