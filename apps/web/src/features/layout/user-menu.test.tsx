import { describe, expect, test } from 'bun:test';

import { TERMINAL_THEMES } from '@/lib/interface-themes';
import { useSettingsPanelStore } from '@kortix/ui/internal/stores/settings-panel-store';

import en from '../../../translations/en.json';
import { INTERFACE_THEME_OPTIONS } from './interface-theme';

/**
 * What is NOT covered here, and why.
 *
 * The user menu's row order, the Theme submenu's radio semantics and the
 * selected-state check all live inside a Radix `DropdownMenuContent`, which
 * renders nothing until the menu is open and then renders through a portal.
 * `apps/web` has no DOM harness — no jsdom, no testing-library — and
 * `renderToStaticMarkup` returns an empty string for portalled content, so none
 * of that is reachable from a unit test. It is verified by driving the real
 * menu in a browser.
 *
 * What IS reachable is the contract the submenu is built from: the interface
 * theme rows, their order and their labels, shared with the Appearance tab and
 * the command palette. That is what this file locks.
 */
describe('INTERFACE_THEME_OPTIONS', () => {
  test('opens with System, then the four Kortix palettes, then one row per terminal theme', () => {
    expect(INTERFACE_THEME_OPTIONS.slice(0, 5).map((option) => option.value)).toEqual([
      'system',
      'light',
      'pure-light',
      'dark',
      'pure-dark',
    ]);
    expect(INTERFACE_THEME_OPTIONS.slice(0, 5).every((option) => option.kind === 'labelled')).toBe(
      true,
    );
    // Every terminal theme follows, in the generated file's own order.
    expect(INTERFACE_THEME_OPTIONS.slice(5).map((option) => option.value)).toEqual(
      TERMINAL_THEMES.map((theme) => theme.id),
    );
  });

  test('is exactly System + the four Kortix palettes + every terminal theme, no more', () => {
    expect(INTERFACE_THEME_OPTIONS).toHaveLength(1 + 4 + TERMINAL_THEMES.length);
  });

  test('keeps System, so the menu can still hand the choice back to the OS', () => {
    // Dropping this row would silently pin every user to a fixed theme with no
    // way back to following the system, which is the default for a new account.
    expect(INTERFACE_THEME_OPTIONS.some((option) => option.value === 'system')).toBe(true);
  });

  test('every Kortix row label resolves in the English catalog', () => {
    const themes = en.settings.appearance.themes as Record<string, string>;
    const labelled = INTERFACE_THEME_OPTIONS.filter((option) => option.kind === 'labelled');
    expect(labelled.map((option) => themes[option.labelKey])).toEqual([
      'System',
      'Light',
      'Pure light',
      'Dark',
      'Pure dark',
    ]);
  });

  test('a terminal theme row shows its own proper noun, verbatim, not a translated label', () => {
    const named = INTERFACE_THEME_OPTIONS.filter((option) => option.kind === 'named');
    expect(named).toHaveLength(TERMINAL_THEMES.length);
    for (const option of named) {
      const source = TERMINAL_THEMES.find((theme) => theme.id === option.value);
      expect({ name: option.name, family: option.family, group: option.group }).toEqual({
        name: source?.name ?? '',
        family: source?.family ?? '',
        group: source?.mode ?? 'light',
      });
    }
    // Names like "Catppuccin Mocha" and "Rosé Pine Dawn" are not English catalog
    // keys and must never be looked up as one.
    expect(named.some((option) => option.name === 'Catppuccin Mocha')).toBe(true);
  });
});

describe('settings store and theme compatibility contracts', () => {
  test('the settings panel store opens on profile and preferences', () => {
    for (const tab of ['profile', 'preferences'] as const) {
      useSettingsPanelStore.getState().openSettings(tab);
      expect(useSettingsPanelStore.getState().open).toBe(true);
      expect(useSettingsPanelStore.getState().tab).toBe(tab);
    }
    useSettingsPanelStore.getState().close();
  });

  test('the compatibility entry point shares the live theme options', async () => {
    const compat = await import('./user-menu');
    expect(compat.INTERFACE_THEME_OPTIONS).toBe(INTERFACE_THEME_OPTIONS);
  });
});
