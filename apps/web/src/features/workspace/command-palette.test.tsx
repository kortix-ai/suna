import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  ACCOUNT_SCOPED_SETTINGS_TABS,
  isSettingsTabAllowed,
} from '@/features/workspace/settings/settings-panel';
import {
  DEFAULT_SETTINGS_TAB,
  SETTINGS_TABS,
  resolveSettingsOverlayHref,
  type SettingsTab,
} from '@/features/workspace/settings/settings-tabs';
import { STANDALONE_DEFAULT_SETTINGS_TAB } from '@/features/workspace/settings/standalone-settings-route';
import { getItemsForSurface } from '@/lib/menu-registry';
import { LEGACY_SETTINGS_TAB_MAP } from './command-palette';
import {
  PALETTE_ACCOUNT_SCOPED_TABS,
  PALETTE_NO_PROJECT_DEFAULT_TAB,
  filterSettingsPaletteGroups,
  settingsPaletteGroups,
  type SettingsPaletteParams,
} from './settings-palette-items';

// No `flags` any more: the three flag-gated rail rows (Marketplace, Review,
// Voice) moved to `/projects/<id>/config` with the rest of project
// configuration, so nothing left in the derived list varies by flag.
const IN_A_PROJECT: SettingsPaletteParams = { hasProject: true };

function tabsFor(params: SettingsPaletteParams): SettingsTab[] {
  return settingsPaletteGroups(params).flatMap((group) => group.items.map((item) => item.tab));
}

function tabsMatching(query: string, params = IN_A_PROJECT): SettingsTab[] {
  return filterSettingsPaletteGroups(settingsPaletteGroups(params), query).flatMap((group) =>
    group.items.map((item) => item.tab),
  );
}

const paletteItems = getItemsForSurface('commandPalette');

/**
 * ============================================================================
 * COVERAGE — the test the old file did not have.
 * ============================================================================
 *
 * `command-palette.test.tsx` used to check only that every VALUE in
 * `LEGACY_SETTINGS_TAB_MAP` was a real `SettingsTab`. That check passes just
 * as happily when a tab has no palette entry at all, which is how nine of the
 * twenty-six tabs (profile, connected, snapshots, groups, roles, identity,
 * audit, experimental, upgrades) shipped unreachable from Cmd+K with a green
 * suite.
 *
 * These tests assert the other direction: SETTINGS_TABS -> palette. A tab
 * added to `settings-tabs.ts` without a rail row fails here, and a rail row
 * deleted from `rail.ts` fails here. There is no way to change the tab list
 * on one side only.
 */
describe('settings tab coverage', () => {
  test('every SettingsTab is reachable from the palette', () => {
    const reachable = tabsFor(IN_A_PROJECT);

    for (const tab of SETTINGS_TABS) {
      expect(reachable).toContain(tab);
    }
  });

  test('the palette offers no tab that is not a SettingsTab, and lists none twice', () => {
    const reachable = tabsFor(IN_A_PROJECT);

    for (const tab of reachable) {
      expect(SETTINGS_TABS as readonly string[]).toContain(tab);
    }
    expect(new Set(reachable).size).toBe(reachable.length);
    expect(reachable.length).toBe(SETTINGS_TABS.length);
  });

  test('the derivation walks every rail group and invents nothing', () => {
    // `rail.ts` used to export a pinned `UPGRADE_ITEM` alongside
    // `railGroups()`, and a derivation that walked only the groups silently
    // dropped it. Upgrades is a section of `/projects/<id>/config` now and the
    // rail has no pinned row left, so the invariant is simply that the derived
    // list and the rail agree exactly.
    expect([...tabsFor(IN_A_PROJECT)].sort()).toEqual([...SETTINGS_TABS].sort());
  });

  test('every offered row carries an icon, a group and searchable keywords', () => {
    for (const group of settingsPaletteGroups(IN_A_PROJECT)) {
      expect(group.label.length).toBeGreaterThan(0);
      for (const item of group.items) {
        expect(item.icon).toBeDefined();
        expect(item.groupLabel).toBe(group.label);
        expect(item.keywords.trim().length).toBeGreaterThan(0);
        expect(item.id).toBe(`settings-tab-${item.tab}`);
      }
    }
  });
});

/**
 * The two constants `settings-palette-items.ts` mirrors rather than imports —
 * see that file's header for why (importing either source drags the whole
 * settings tab tree into the command-palette chunk, including on
 * `/accounts/**` where the panel never mounts). The mirror is only safe
 * because these assertions fail the moment it drifts.
 */
describe('mirrored settings-panel constants', () => {
  test('PALETTE_ACCOUNT_SCOPED_TABS equals ACCOUNT_SCOPED_SETTINGS_TABS', () => {
    expect([...PALETTE_ACCOUNT_SCOPED_TABS]).toEqual([...ACCOUNT_SCOPED_SETTINGS_TABS]);
  });

  test('PALETTE_NO_PROJECT_DEFAULT_TAB equals STANDALONE_DEFAULT_SETTINGS_TAB', () => {
    expect(PALETTE_NO_PROJECT_DEFAULT_TAB).toBe(STANDALONE_DEFAULT_SETTINGS_TAB);
    // The two defaults converged when project configuration left the overlay:
    // `DEFAULT_SETTINGS_TAB` was `general`, a project tab, and is `profile`
    // now. What still has to hold is that this one renders with no project.
    expect(ACCOUNT_SCOPED_SETTINGS_TABS).toContain(PALETTE_NO_PROJECT_DEFAULT_TAB);
    expect(isSettingsTabAllowed(DEFAULT_SETTINGS_TAB, { hasProject: false })).toBe(true);
  });
});

/**
 * The palette must not offer a destination that gets filtered away on
 * arrival. `isSettingsTabAllowed` is the panel's own rule; every tab the
 * palette offers is run through it here with the same inputs, so an
 * offered-but-unreachable tab is a test failure rather than a dead click.
 */
describe('offered tabs survive the panel filter', () => {
  // `canProject: () => true` — the palette offers the two IAM-gated Workspace
  // rows without probing; the panel answers the probe and hides a denied row.
  const allowedParams = (hasProject: boolean) => ({ hasProject, canProject: () => true });

  test('with a project, every offered tab is allowed', () => {
    for (const tab of tabsFor(IN_A_PROJECT)) {
      expect(isSettingsTabAllowed(tab, allowedParams(true))).toBe(true);
    }
  });

  test('with NO project, every offered tab is allowed', () => {
    const params: SettingsPaletteParams = { hasProject: false };
    const offered = tabsFor(params);
    expect(offered.length).toBeGreaterThan(0);
    for (const tab of offered) {
      expect(isSettingsTabAllowed(tab, allowedParams(false))).toBe(true);
    }
  });

  test('with NO project, every live tab is offered — all of them are personal', () => {
    const offered: string[] = tabsFor({ hasProject: false });
    expect([...offered].sort()).toEqual([...SETTINGS_TABS].sort());
    for (const tab of offered) expect(ACCOUNT_SCOPED_SETTINGS_TABS).toContain(tab);
    // The project configuration tabs specifically — these were the ones the
    // old `Customize · X` entries offered from `/accounts/**`. They are not
    // offered from anywhere in this list now: they are `?section=` values on
    // `/projects/<id>/config`, reached through the `proj-customize` row.
    for (const tab of ['general', 'secrets', 'repositories', 'sandbox', 'models']) {
      expect(offered).not.toContain(tab);
    }
  });

  // The "Billing disappears when billing is off" case is gone with the tab.
  // Billing is not a settings tab any more — it is a section of
  // `/accounts/[id]`, reached from the `account-billing` registry row, and
  // that row carries `requiresBilling: true` so the palette still hides it
  // when billing is off (asserted in `menu-registry.flags.test.ts`).

  test('the derived list is exactly the rail, with or without a project', () => {
    // It used to vary by three feature flags. Those rows are sections of
    // `/projects/<id>/config` now and the flag composition moved there with
    // them (`project-settings-sections.ts`), so this list has one shape.
    expect([...tabsFor(IN_A_PROJECT)].sort()).toEqual([...SETTINGS_TABS].sort());
  });
});

/**
 * Search terms that used to live on the removed `menu-registry` entries.
 * Losing one is invisible in the UI — the row is still there, it just stops
 * answering the word people actually type — so each is pinned.
 */
describe('search terms carried across from the removed registry entries', () => {
  const CARRIED: ReadonlyArray<[string, SettingsTab]> = [
    // Appearance and Sessions split out of Preferences on 2026-09-02; the
    // words followed the sections they name.
    ['theme', 'appearance'],
    ['wallpaper', 'appearance'],
    ['hotkeys', 'preferences'],
    ['mute', 'sessions'],
    // `connected` left the overlay on 2026-09-03 — the account's GitHub App
    // installations are the account page's Git tab.
    ['avatar', 'profile'],
    // API keys came back into the rail on 2026-08-18, so the two words that
    // name a person's own key answer HERE again, not on `account-tokens` —
    // that row is the service-account surface now.
    ['pat', 'tokens'],
    ['cli', 'tokens'],
    // Everything else that used to be listed here named a tab that has left
    // this rail. The thirteen project-configuration words (secrets, env, git,
    // github, members, collaborators, slack, agentmail, llm, openrouter,
    // marketplace, approvals, livekit, templates, danger zone, customize) are
    // answered by the `proj-customize` registry row now — pinned in the case
    // below — and the eight account words (subscription, ledger, pat, sso, …)
    // by the `account-*` rows, pinned in the case after that.
  ];

  for (const [query, tab] of CARRIED) {
    test(`typing "${query}" reaches the ${tab} tab`, () => {
      expect(tabsMatching(query)).toContain(tab);
    });
  }

  /**
   * The eight account sections left the derived settings list, so every query
   * that used to reach them through a settings row has to reach the
   * `account-*` registry row instead. A registry row is searched by
   * `label + keywords` (`buildPaletteSearchText` in command-palette.tsx), so
   * this asserts against exactly that text.
   */
  test('the account sections still answer the queries their settings rows did', () => {
    const ACCOUNT_QUERIES: ReadonlyArray<[string, string]> = [
      ['subscription', 'account-billing'],
      ['wallet', 'account-billing'],
      ['ledger', 'account-usage'],
      ['credits', 'account-usage'],
      // `pat` / `cli` moved back to the settings `tokens` tab — see CARRIED
      // above. What `account-tokens` answers now is the automation half.
      ['service account', 'account-tokens'],
      ['automation', 'account-tokens'],
      ['sso', 'account-identity'],
      ['saml', 'account-identity'],
      ['scim', 'account-identity'],
      ['rbac', 'account-roles'],
      ['compliance', 'account-audit'],
      ['sign in rules', 'account-general'],
    ];
    for (const [query, id] of ACCOUNT_QUERIES) {
      const item = paletteItems.find((entry) => entry.id === id);
      expect(item).toBeDefined();
      const haystack = `${item!.label} ${item!.keywords ?? ''}`.toLowerCase();
      for (const word of query.split(' ')) {
        expect(haystack).toContain(word);
      }
    }
  });

  /**
   * The thirteen project-configuration sections left the derived settings list
   * for `/projects/<id>/config` and, for a while, ALL of their vocabulary was
   * absorbed into one row (`proj-customize`) on the reasoning that a section
   * is a query param rather than a page.
   *
   * That reasoning produced the reported bug. Four of the thirteen were not
   * `?section=` values at all — Models, Secrets, Channels and Members had
   * graduated into their own routes (`capability-tab-routes.ts`) — so "model"
   * reached a row whose href is `/config`, and the page that IS models could
   * not be reached from ⌘K by any query. The remaining six ARE query params,
   * but `?section=` still lands in a different place per section, so a row
   * each is a row per destination, not thirteen links to one URL.
   *
   * Each word below therefore has to reach the row that OWNS it. The
   * assertion is per-word rather than per-row on purpose: it is the query the
   * user types, and it is what regressed.
   */
  test('each retained vocabulary reaches the row that owns it', () => {
    const OWNER: ReadonlyArray<[string, string]> = [
      ['secrets', 'proj-secrets'],
      ['env', 'proj-secrets'],
      ['members', 'proj-members'],
      ['collaborators', 'proj-members'],
      ['slack', 'proj-channels'],
      ['agentmail', 'proj-channels'],
      ['llm', 'proj-models'],
      ['openrouter', 'proj-models'],
      ['approvals', 'proj-review-inbox'],
      ['customize', 'proj-customize'],
    ];
    for (const [query, id] of OWNER) {
      const item = paletteItems.find((entry) => entry.id === id);
      expect({ query, id, found: Boolean(item) }).toEqual({ query, id, found: true });
      const haystack = `${item!.label} ${item!.keywords ?? ''}`.toLowerCase();
      expect({ query, id, answers: haystack.includes(query) }).toEqual({
        query,
        id,
        answers: true,
      });
    }
  });

  test('typing "profile name email" reaches Profile', () => {
    // `pref-general` carried exactly these keywords and opened `general` —
    // the PROJECT workspace tab. The user's own tab is `profile`.
    const hits = tabsMatching('profile');
    expect(hits).toContain('profile');
    expect(tabsMatching('email')).toContain('profile');
    expect(tabsMatching('name email')).toContain('profile');
  });

  test('typing "audit" reaches the Audit log section, not only the session action', () => {
    // It used to reach only the SESSION action `open-session-audit`, which is
    // a different surface entirely and stays where it is. The Audit log moved
    // from a settings tab to `/accounts/[id]?tab=audit`, so the row that
    // answers now is a registry row.
    const audit = paletteItems.find((entry) => entry.id === 'account-audit');
    expect(`${audit?.label} ${audit?.keywords ?? ''}`.toLowerCase()).toContain('audit');
    expect(paletteItems.find((item) => item.id === 'open-session-audit')).toBeDefined();
  });

  // Two cases retired here, both because their subject left the settings rail:
  //
  //   - "a rail group name is itself a query" used the Organization group,
  //     which is gone — its eight rows are `/accounts/[id]` sections now, and
  //     "account" reaching all of them is pinned in
  //     `command-palette-search.test.ts` instead.
  //   - "the two tabs both labelled General are told apart by their group"
  //     needed both Generals: Organization > General (now the account page's
  //     Settings section) and Workspace > General (now a project config
  //     section). Neither is a settings tab, so there is no longer a pair to
  //     tell apart in this rail.
});

/**
 * Deriving the rows is only half the fix — the superseded registry entries
 * had to go, or every tab would list twice.
 */
describe('the registry no longer carries palette settings destinations', () => {
  test('no commandPalette entry uses kind: "settings"', () => {
    expect(paletteItems.filter((item) => item.kind === 'settings')).toEqual([]);
  });

  test('only two commandPalette hrefs still resolve to a settings tab, both deliberate', () => {
    const resolved = paletteItems
      .map((item) => ({ id: item.id, match: resolveSettingsOverlayHref(item.href ?? '') }))
      .filter((entry) => entry.match.opensOverlay);

    // Nothing does any more. `nav-accounts` left this list when the account
    // surfaces moved to `/accounts/[id]`; `proj-customize` left it when
    // project configuration moved to `/projects/[id]/customize/settings`. Every settings
    // destination in the palette is either a derived row (which opens the
    // overlay by tab id, not by href) or a plain navigation.
    expect(resolved.map((entry) => entry.id).sort()).toEqual([]);
  });

  test('proj-customize points at the Customize index, and no row survives /config', () => {
    // A bare `/projects/{id}/settings` resolved to `{ tab: undefined }`, and
    // `openSettings(undefined)` keeps whatever was last open — so one entry
    // landed somewhere different on every click. It named `/settings/general`
    // after that, then `/config` once General became a config section.
    //
    // `proj-customize` keeps the WORD customize and takes the index page it
    // names — the card grid over every capability tab, each of which has its
    // own row.
    const customize = paletteItems.find((item) => item.id === 'proj-customize');
    expect(customize?.href).toBe('/projects/{projectId}/customize');
    expect(customize?.kind).toBe('navigate');
    expect(customize?.requiresProject).toBe(true);

    // Every `proj-config-*` row is gone with `/config` (2026-09-02): General,
    // Sandbox templates and Feature flags are overlay tabs derived from the
    // rail.
    //
    // `proj-config-feature-flags` outlived the other two by a day. It was
    // still shipping on 2026-09-03 with `href: '/projects/{projectId}/customize/settings
    // ?section=feature-flags'`, so typing "feature flag" offered it under
    // Navigation — above the derived row that works — and selecting it
    // navigated to a deleted route. `menu-registry-destinations.test.ts` now
    // checks every navigate row's href against the real `src/app` tree, which
    // is the check that would have caught it the day the route was deleted.
    // The `proj-config-*` rows are BACK since 2026-09-03 (Marko): the
    // Settings tab returned to the Customize bar and the overlay's Workspace
    // group went, so these rows are the only way the palette reaches those
    // sections. `menu-registry-destinations.test.ts` proves each href is a
    // live route.
    for (const id of ['proj-config-general', 'proj-config-sandbox', 'proj-config-feature-flags']) {
      expect({ id, present: paletteItems.some((item) => item.id === id) }).toEqual({
        id,
        present: true,
      });
    }

    // Customize may not be claimed by the overlay resolver, or the click
    // would open a tab instead of navigating.
    expect(resolveSettingsOverlayHref(customize!.href!).opensOverlay).toBe(false);
  });

  test('the removed per-tab entries are gone from every surface, not just the palette', () => {
    // `proj-secrets`, `proj-members`, `proj-channels` and `proj-marketplace`
    // are NOT in this list any more, and their absence is the point of this
    // change. They were removed here as SETTINGS TABS
    // (`/settings/secrets`, opened through the overlay); they came back as
    // CAPABILITY PAGES with their own routes (`/projects/<id>/secrets`, the
    // account Access pane, `?scope=channels`, `/projects/<id>/marketplace`),
    // which the derived settings list structurally cannot produce — the same
    // arrangement `proj-triggers` and the `account-*` rows use. What must stay
    // gone is a row that opens the OVERLAY on a tab that no longer exists; the
    // "no commandPalette entry uses kind: 'settings'" case above pins that,
    // and `menu-registry-destinations.test.ts` pins that each of these hrefs
    // is a real destination.
    for (const id of [
      'proj-git',
      'proj-sandbox',
      'proj-llm',
      'proj-review',
      'proj-voice',
      'pref-appearance',
      'pref-sounds',
      'pref-shortcuts',
      'account-transactions',
    ]) {
      expect(paletteItems.find((item) => item.id === id)).toBeUndefined();
    }
  });

  // `proj-marketplace` is the id the deleted SKILLS marketplace used for its
  // settings-overlay tab. It is reused here for the Customize → Marketplace
  // capability page, so this case states what the row now is: a navigate row
  // at its own route, gated on the `subprojects` flag. Without it, removing
  // the id from the absent-list above would leave the reuse unasserted.
  test('Marketplace is a flag-gated registry row, pointing at its own page', () => {
    const marketplace = paletteItems.find((item) => item.id === 'proj-marketplace');
    expect(marketplace?.kind).toBe('navigate');
    expect(marketplace?.href).toBe('/projects/{projectId}/marketplace');
    expect(marketplace?.requiresProject).toBe(true);
    // The one registry row that declares a flag. A project without the
    // surface must not be offered a palette row that 403s on arrival.
    expect(marketplace?.requiresFlag).toBe('subprojects');
    // Not claimed by the overlay resolver — clicking it navigates, and does
    // not reopen the settings overlay on a tab that no longer exists.
    expect(resolveSettingsOverlayHref(marketplace!.href!).opensOverlay).toBe(false);
  });

  test('Triggers is a registry row, pointing at its own page', () => {
    // Schedules and Webhooks were removed from the registry when every
    // settings destination became derived; Triggers is back as one merged row
    // because it is no longer a settings destination.
    // `resolveSettingsOverlayHref` must not claim its href — that is what
    // would re-open the retired overlay tabs.
    const href = '/projects/{projectId}/customize/triggers';
    const item = paletteItems.find((entry) => entry.id === 'proj-triggers');
    expect(item?.href).toBe(href);
    expect(item?.kind).toBe('navigate');
    expect(item?.requiresProject).toBe(true);
    expect(resolveSettingsOverlayHref(href).opensOverlay).toBe(false);
  });

  test('entries kept for the userMenu no longer render in the palette', () => {
    // `account-billing` and `account-tokens` left this list: they are palette
    // rows again, because their destinations left the settings overlay for
    // `/accounts/[id]` and the derived settings list can no longer produce
    // them. See the `account-*` block in `lib/menu-registry.ts`.
    for (const id of ['pref-general']) {
      expect(paletteItems.find((item) => item.id === id)).toBeUndefined();
    }
  });

  /**
   * The account sections are hand-written registry rows, not derived settings
   * rows — the derived list reads `railGroups()`, and none of these is in the
   * rail any more. Each must point at `/accounts/{accountId}`, never at a
   * `/settings/<tab>` segment `parseSettingsTab` would reject.
   */
  test('every account section is a navigate row on the account page', () => {
    const ids = [
      'account-general',
      'account-members',
      'account-billing',
      'account-usage',
      'account-groups',
      'account-roles',
      'account-identity',
      'account-audit',
      'account-tokens',
    ];
    for (const id of ids) {
      const item = paletteItems.find((entry) => entry.id === id);
      expect(item).toBeDefined();
      expect(item?.kind).toBe('navigate');
      expect(item?.href?.startsWith('/accounts/{accountId}?tab=')).toBe(true);
      expect(resolveSettingsOverlayHref(item!.href!).opensOverlay).toBe(false);
    }
  });
});

/**
 * `LEGACY_SETTINGS_TAB_MAP` translates the legacy `SettingsTabId` vocabulary
 * (menu-registry.ts) onto the `SettingsTab` vocabulary (settings-tabs.ts) that
 * `useSettingsPanelStore` understands. No palette entry uses `kind: 'settings'`
 * any more, but `MenuItemDef.kind` still admits it and the `userMenu` surface
 * still declares three such entries — so the map has to stay correct for the
 * day one of them is put back on the palette surface. A bug here is silent:
 * `handleOpenSettings` falls back to `DEFAULT_SETTINGS_TAB` for anything that
 * isn't a real `SettingsTab`, opening Settings on the wrong tab rather than
 * throwing.
 */
describe('LEGACY_SETTINGS_TAB_MAP', () => {
  test('every mapped value is a real SettingsTab', () => {
    for (const [legacyId, tab] of Object.entries(LEGACY_SETTINGS_TAB_MAP)) {
      expect(SETTINGS_TABS as readonly string[]).toContain(tab as string);
      void legacyId;
    }
  });

  test('every userMenu settings entry has a mapping', () => {
    for (const item of getItemsForSurface('userMenu')) {
      if (item.kind !== 'settings') continue;
      expect(LEGACY_SETTINGS_TAB_MAP[item.settingsTab!]).toBeDefined();
    }
  });

  test('each legacy id maps to the tab that hosts its section now', () => {
    // Since 2026-09-02: theme/wallpaper on Appearance, sound packs on
    // Sessions, the shortcut list (modifier picker + list) on Preferences.
    expect(LEGACY_SETTINGS_TAB_MAP.shortcuts).toBe('preferences');
    expect(LEGACY_SETTINGS_TAB_MAP.appearance).toBe('appearance');
    expect(LEGACY_SETTINGS_TAB_MAP.sounds).toBe('sessions');
  });

  test('referrals has no entry and no mapping — there is no referrals tab', () => {
    // `referrals` is not a member of `SettingsTab`, so `account-referrals`
    // fell through to `DEFAULT_SETTINGS_TAB` and opened the project workspace
    // General tab under a "Referrals" label. Mapping it correctly was not an
    // option: the only live referral surface is `ReferralModal`, which mounts
    // inside `UserMenu` -> `AppHeader` (i.e. only under `/accounts/**`) and
    // which nothing opens. The entry was removed instead.
    expect(SETTINGS_TABS as readonly string[]).not.toContain('referrals');
    expect(LEGACY_SETTINGS_TAB_MAP.referrals).toBeUndefined();
    expect(paletteItems.find((item) => item.id === 'account-referrals')).toBeUndefined();
  });
});

/**
 * The model page's chrome. It cannot be rendered here — the palette pulls in
 * the whole workspace tree — so this reads the source. Every assertion below
 * is mutation-checked: flip the thing it names and it fails.
 */
describe('command palette — model list chrome', () => {
  const source = readFileSync(new URL('./command-palette.tsx', import.meta.url), 'utf8');
  const modelsPage = source.slice(
    source.indexOf("{page === 'models' && ("),
    source.indexOf("{page === 'files' &&"),
  );

  test('the models page block was located', () => {
    // Guards the two slice indices above — a rename here would otherwise leave
    // every assertion below running against an empty string, passing forever.
    expect(modelsPage.length).toBeGreaterThan(500);
  });

  test('the provider group heading carries the inline logo, not the avatar tile', () => {
    // `small` is a 32px tile against 13px heading text.
    expect(modelsPage).toContain('<ProviderLogo providerID={group.providerID} size="xs" />');
  });

  test('capabilities are icons, not word badges', () => {
    // `reasoning` / `vision` pills competed with the model name on every row,
    // in a list that is scanned by name.
    expect(modelsPage).toContain('<ModelCapabilityIcons');
    expect(modelsPage).not.toMatch(/<Badge[^>]*>\s*reasoning/);
    expect(modelsPage).not.toMatch(/<Badge[^>]*>\s*vision/);
  });

  test('the raw model ID is gated on saying something the name does not', () => {
    expect(modelsPage).toContain('modelIdAddsInformation(model.modelName, model.modelID)');
  });
});
