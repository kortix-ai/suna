import { describe, expect, test } from 'bun:test';
import { SETTINGS_TABS, parseSettingsTab } from './settings-tabs';

describe('settings route segments', () => {
  test('every tab id is a usable URL segment', () => {
    for (const tab of SETTINGS_TABS) {
      expect(tab).toMatch(/^[a-z0-9-]+$/);
      expect(parseSettingsTab(tab)).toBe(tab);
    }
  });

  test('an unknown segment does not resolve to a tab', () => {
    expect(parseSettingsTab('nope')).toBeNull();
    expect(parseSettingsTab('Members')).toBeNull();
  });
});
