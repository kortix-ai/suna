import { describe, expect, test } from 'bun:test';

import {
  ACCOUNT_SCOPED_SETTINGS_TABS,
  isSettingsTabAllowed,
} from '@/features/workspace/settings/settings-panel';
import { STANDALONE_DEFAULT_SETTINGS_TAB } from '@/features/workspace/settings/standalone-settings-route';
import type { RailFlags } from '@/features/workspace/settings/rail';
import {
  DEFAULT_SETTINGS_TAB,
  SETTINGS_TABS,
  resolveSettingsOverlayHref,
  type SettingsTab,
} from '@/features/workspace/settings/settings-tabs';
import { getItemsForSurface } from '@/lib/menu-registry';
import { LEGACY_SETTINGS_TAB_MAP } from './command-palette';
import {
  PALETTE_ACCOUNT_SCOPED_TABS,
  PALETTE_NO_PROJECT_DEFAULT_TAB,
  filterSettingsPaletteGroups,
  settingsPaletteGroups,
  type SettingsPaletteParams,
} from './settings-palette-items';

const ALL_FLAGS_ON: RailFlags = {
  marketplaceEnabled: true,
  llmGatewayAvailable: true,
  voiceEnabled: true,
  reviewEnabled: true,
};
const ALL_FLAGS_OFF: RailFlags = {
  marketplaceEnabled: false,
  llmGatewayAvailable: false,
  voiceEnabled: false,
  reviewEnabled: false,
};

const IN_A_PROJECT: SettingsPaletteParams = {
  hasProject: true,
  flags: ALL_FLAGS_ON,
  billingEnabled: true,
};

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

  test('the pinned Upgrades item is included even though it is in no rail group', () => {
    // `rail.ts` exports UPGRADE_ITEM separately from `railGroups()` — it is
    // pinned to the rail's footer. A derivation that walked only the groups
    // would silently drop it.
    expect(tabsFor(IN_A_PROJECT)).toContain('upgrades');
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
    // And it must not be the project-scoped default, which is the bug the
    // standalone route already had to fix.
    expect(PALETTE_NO_PROJECT_DEFAULT_TAB).not.toBe(DEFAULT_SETTINGS_TAB);
  });
});

/**
 * The palette must not offer a destination that gets filtered away on
 * arrival. `isSettingsTabAllowed` is the panel's own rule; every tab the
 * palette offers is run through it here with the same inputs, so an
 * offered-but-unreachable tab is a test failure rather than a dead click.
 */
describe('offered tabs survive the panel filter', () => {
  const allowedParams = (hasProject: boolean, billingEnabled: boolean) => ({
    hasProject,
    // Unresolved probes: `isSettingsTabAllowed` fail-opens on both, exactly
    // as it does on a real first paint.
    projectCapsResolved: false,
    projectCan: () => true,
    accountPermsResolved: false,
    accountCan: () => true,
    billingEnabled,
  });

  test('with a project, every offered tab is allowed', () => {
    for (const tab of tabsFor(IN_A_PROJECT)) {
      expect(isSettingsTabAllowed(tab, allowedParams(true, true))).toBe(true);
    }
  });

  test('with NO project, every offered tab is allowed', () => {
    const params: SettingsPaletteParams = {
      hasProject: false,
      flags: ALL_FLAGS_ON,
      billingEnabled: true,
    };
    const offered = tabsFor(params);
    expect(offered.length).toBeGreaterThan(0);
    for (const tab of offered) {
      expect(isSettingsTabAllowed(tab, allowedParams(false, true))).toBe(true);
    }
  });

  test('with NO project, only account-scoped tabs are offered', () => {
    const offered = tabsFor({ hasProject: false, flags: ALL_FLAGS_ON, billingEnabled: true });
    expect([...offered].sort()).toEqual([...ACCOUNT_SCOPED_SETTINGS_TABS].sort());
    // The project workspace tabs specifically — these were the ones the old
    // `Customize · X` entries offered from `/accounts/**`.
    for (const tab of ['general', 'secrets', 'repositories', 'sandbox', 'models'] as const) {
      expect(offered).not.toContain(tab);
    }
  });

  test('Billing disappears when billing is off', () => {
    expect(tabsFor({ ...IN_A_PROJECT, billingEnabled: false })).not.toContain('billing');
    expect(tabsFor(IN_A_PROJECT)).toContain('billing');
  });

  test('flag-gated tabs disappear with their flag', () => {
    const off = tabsFor({ ...IN_A_PROJECT, flags: ALL_FLAGS_OFF });
    expect(off).not.toContain('marketplace');
    expect(off).not.toContain('review');
    expect(off).not.toContain('voice');
    // ...but the rail's ungated rows survive every flag.
    expect(off).toContain('models');
    expect(off).toContain('snapshots');
  });
});

/**
 * Search terms that used to live on the removed `menu-registry` entries.
 * Losing one is invisible in the UI — the row is still there, it just stops
 * answering the word people actually type — so each is pinned.
 */
describe('search terms carried across from the removed registry entries', () => {
  const CARRIED: ReadonlyArray<[string, SettingsTab]> = [
    ['secrets', 'secrets'],
    ['env', 'secrets'],
    ['git', 'repositories'],
    ['github', 'repositories'],
    ['members', 'members'],
    ['collaborators', 'members'],
    ['cron', 'schedules'],
    ['webhooks', 'webhooks'],
    ['slack', 'channels'],
    ['agentmail', 'channels'],
    ['llm', 'models'],
    ['openrouter', 'models'],
    ['marketplace', 'marketplace'],
    ['approvals', 'review'],
    ['livekit', 'voice'],
    ['templates', 'sandbox'],
    ['theme', 'preferences'],
    ['wallpaper', 'preferences'],
    ['hotkeys', 'preferences'],
    ['mute', 'preferences'],
    ['subscription', 'billing'],
    ['ledger', 'usage'],
    ['pat', 'api-keys'],
    ['danger zone', 'general'],
    ['customize', 'general'],
  ];

  for (const [query, tab] of CARRIED) {
    test(`typing "${query}" reaches the ${tab} tab`, () => {
      expect(tabsMatching(query)).toContain(tab);
    });
  }

  test('typing "profile name email" reaches Profile, not the workspace General tab', () => {
    // `pref-general` carried exactly these keywords and opened `general` —
    // the PROJECT workspace tab. The user's own tab is `profile`.
    const hits = tabsMatching('profile');
    expect(hits).toContain('profile');
    expect(hits).not.toContain('general');
    expect(tabsMatching('email')).toContain('profile');
    expect(tabsMatching('name email')).toContain('profile');
  });

  test('typing "snapshot" reaches the Snapshots tab', () => {
    // It used to reach Sandbox templates only (`proj-sandbox`'s keyword) and
    // could not reach Snapshots at all.
    expect(tabsMatching('snapshot')).toContain('snapshots');
    expect(tabsMatching('snapshots')).toContain('snapshots');
  });

  test('typing "audit" reaches the Audit log tab', () => {
    // It used to reach only the SESSION action `open-session-audit`, which is
    // a different surface entirely and stays where it is.
    expect(tabsMatching('audit')).toContain('audit');
    expect(paletteItems.find((item) => item.id === 'open-session-audit')).toBeDefined();
  });

  test('a rail group name is itself a query, as it is in the rail', () => {
    expect(tabsMatching('organization')).toContain('audit');
    expect(tabsMatching('organization')).toContain('roles');
    expect(tabsMatching('organization')).not.toContain('secrets');
  });

  test('the two tabs both labelled "General" are told apart by their group', () => {
    const groups = filterSettingsPaletteGroups(settingsPaletteGroups(IN_A_PROJECT), 'general');
    const generals = groups.flatMap((group) =>
      group.items.filter((item) => item.label === 'General').map((item) => item.groupLabel),
    );
    expect([...generals].sort()).toEqual(['Organization', 'Workspace']);
  });
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

    expect(resolved.map((entry) => entry.id).sort()).toEqual(['nav-accounts', 'proj-customize']);

    // `nav-accounts` opens the in-palette account switcher; this href is the
    // routed fallback for surfaces without that picker.
    // `proj-customize` is the generic "Customize" door.
    const byId = new Map(resolved.map((entry) => [entry.id, entry.match]));
    expect(byId.get('nav-accounts')).toEqual({ opensOverlay: true, tab: 'organization' });
    expect(byId.get('proj-customize')).toEqual({ opensOverlay: true, tab: 'general' });
  });

  test('proj-customize names a tab instead of resuming the last one', () => {
    // A bare `/projects/{id}/settings` resolved to `{ tab: undefined }`, and
    // `openSettings(undefined)` keeps whatever was last open — so one entry
    // landed somewhere different on every click.
    const customize = paletteItems.find((item) => item.id === 'proj-customize');
    expect(customize?.href).toBe('/projects/{projectId}/settings/general');
    expect(resolveSettingsOverlayHref(customize!.href!)).toEqual({
      opensOverlay: true,
      tab: DEFAULT_SETTINGS_TAB,
    });
  });

  test('the removed per-tab entries are gone from every surface, not just the palette', () => {
    for (const id of [
      'proj-secrets',
      'proj-git',
      'proj-sandbox',
      'proj-marketplace',
      'proj-llm',
      'proj-review',
      'proj-voice',
      'proj-members',
      'proj-schedules',
      'proj-webhooks',
      'proj-channels',
      'proj-settings',
      'pref-appearance',
      'pref-sounds',
      'pref-shortcuts',
      'account-transactions',
    ]) {
      expect(paletteItems.find((item) => item.id === id)).toBeUndefined();
    }
  });

  test('entries kept for the userMenu no longer render in the palette', () => {
    for (const id of ['pref-general', 'account-billing', 'account-tokens']) {
      expect(paletteItems.find((item) => item.id === id)).toBeUndefined();
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

  test('shortcuts maps to preferences, same as appearance and sounds', () => {
    // preferences-tab.tsx hosts all three: wallpaper/theme, sound packs, and
    // a full "Keyboard shortcuts" section (modifier picker + shortcut list).
    expect(LEGACY_SETTINGS_TAB_MAP.shortcuts).toBe('preferences');
    expect(LEGACY_SETTINGS_TAB_MAP.appearance).toBe('preferences');
    expect(LEGACY_SETTINGS_TAB_MAP.sounds).toBe('preferences');
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
