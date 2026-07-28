import { describe, expect, test } from 'bun:test';

import { PROJECT_SETTINGS_TABS } from '@/lib/project-nav';
import {
  MAX_SETTINGS_DESCRIPTION_CHARS,
  SETTINGS_TAB_META,
  settingsTabMeta,
} from './settings-tab-meta';

describe('settings tab meta', () => {
  test('every routable settings tab has a header', () => {
    const missing = PROJECT_SETTINGS_TABS.filter((tab) => !SETTINGS_TAB_META[tab.key]).map(
      (tab) => tab.key,
    );
    expect(missing).toEqual([]);
  });

  test('meta declares no tab that cannot be routed to', () => {
    const routable = new Set(PROJECT_SETTINGS_TABS.map((tab) => tab.key));
    const orphans = Object.keys(SETTINGS_TAB_META).filter((key) => !routable.has(key as never));
    expect(orphans).toEqual([]);
  });

  test('every description is one short line', () => {
    const tooLong = Object.entries(SETTINGS_TAB_META)
      .filter(([, meta]) => meta.description.length > MAX_SETTINGS_DESCRIPTION_CHARS)
      .map(([key, meta]) => `${key}: ${meta.description.length}`);
    expect(tooLong).toEqual([]);

    const multiline = Object.entries(SETTINGS_TAB_META)
      .filter(([, meta]) => meta.description.includes('\n'))
      .map(([key]) => key);
    expect(multiline).toEqual([]);
  });

  test('no title repeats the screen name', () => {
    const echoes = Object.entries(SETTINGS_TAB_META)
      .filter(([, meta]) => meta.title === 'Settings')
      .map(([key]) => key);
    expect(echoes).toEqual([]);
  });

  test('the two migrated tabs no longer own their header', () => {
    expect(settingsTabMeta('general').bodyOwnsHeader).toBe(false);
    expect(settingsTabMeta('repository').bodyOwnsHeader).toBe(false);
  });

  test('unmigrated tabs stay flagged so the shell does not stack two titles', () => {
    for (const key of ['members', 'environment', 'sandbox', 'models', 'upgrades'] as const) {
      expect(settingsTabMeta(key).bodyOwnsHeader).toBe(true);
    }
  });
});
