import { describe, expect, test } from 'bun:test';

import { SETTINGS_TABS } from '@/features/workspace/settings/settings-tabs';
import { LEGACY_SETTINGS_TAB_MAP } from './command-palette';

/**
 * `LEGACY_SETTINGS_TAB_MAP` translates the command palette's legacy
 * `SettingsTabId` vocabulary (menu-registry.ts) onto the new `SettingsTab`
 * vocabulary (settings-tabs.ts) that `useSettingsPanelStore` understands —
 * see the map's own header comment in `command-palette.tsx`. A bug here is
 * silent: `handleOpenSettings` falls back to `DEFAULT_SETTINGS_TAB` for any
 * value that isn't a real `SettingsTab`, so a stale or missing mapping opens
 * Settings on the wrong tab instead of throwing. This pins two things: the
 * `shortcuts` -> `preferences` regression specifically (Fix round 1 — it was
 * omitted, so Cmd+K "Shortcuts" silently landed on General), and the whole
 * class of "some entry's target isn't a real tab" bugs generically.
 */
describe('LEGACY_SETTINGS_TAB_MAP', () => {
  test('every mapped value is a real SettingsTab', () => {
    for (const [legacyId, tab] of Object.entries(LEGACY_SETTINGS_TAB_MAP)) {
      expect(SETTINGS_TABS as readonly string[]).toContain(tab as string);
      void legacyId;
    }
  });

  test('shortcuts maps to preferences, same as appearance and sounds', () => {
    // preferences-tab.tsx hosts all three: wallpaper/theme, sound packs, and
    // a full "Keyboard shortcuts" section (modifier picker + shortcut list).
    expect(LEGACY_SETTINGS_TAB_MAP.shortcuts).toBe('preferences');
    expect(LEGACY_SETTINGS_TAB_MAP.appearance).toBe('preferences');
    expect(LEGACY_SETTINGS_TAB_MAP.sounds).toBe('preferences');
  });

  test('referrals is deliberately absent — no referral content exists under settings/ yet', () => {
    expect(LEGACY_SETTINGS_TAB_MAP.referrals).toBeUndefined();
  });
});
