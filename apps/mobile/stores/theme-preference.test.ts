import { describe, expect, test } from 'bun:test';

import { DEFAULT_THEME_PREFERENCE, parseThemePreference } from './theme-preference';

describe('parseThemePreference', () => {
  test('defaults to light', () => {
    expect(DEFAULT_THEME_PREFERENCE).toBe('light');
  });

  test('a fresh install (no saved value) starts in light mode', () => {
    expect(parseThemePreference(null)).toBe('light');
    expect(parseThemePreference(undefined)).toBe('light');
  });

  test('an explicit saved choice is kept', () => {
    expect(parseThemePreference('light')).toBe('light');
    expect(parseThemePreference('dark')).toBe('dark');
    expect(parseThemePreference('system')).toBe('system');
  });

  test('an unknown or empty saved value falls back to light', () => {
    expect(parseThemePreference('')).toBe('light');
    expect(parseThemePreference('Dark')).toBe('light');
    expect(parseThemePreference('auto')).toBe('light');
  });
});
