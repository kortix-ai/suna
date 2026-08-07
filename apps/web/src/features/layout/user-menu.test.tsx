import { describe, expect, test } from 'bun:test';

import { Monitor } from '@/features/icon/icons/monitor';
import { Moon } from '@/features/icon/icons/moon';
import { Sun } from '@/features/icon/icons/sun';

import { THEME_OPTIONS } from './user-menu';

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
 * What IS reachable is the contract the submenu is built from: the three theme
 * values, their labels, their order, and the icons they share with the
 * Appearance tab. That is what this file locks.
 */
describe('THEME_OPTIONS', () => {
  test('offers exactly the three values next-themes accepts', () => {
    expect(THEME_OPTIONS.map((option) => option.value)).toEqual(['light', 'dark', 'system']);
  });

  test('keeps System, so the menu can still hand the choice back to the OS', () => {
    // Dropping this row would silently pin every user to a fixed theme with no
    // way back to following the system, which is the default for a new account.
    expect(THEME_OPTIONS.some((option) => option.value === 'system')).toBe(true);
  });

  test('labels each value the way the Appearance tab labels it', () => {
    expect(THEME_OPTIONS.map((option) => option.label)).toEqual(['Light', 'Dark', 'System']);
  });

  test('draws each row with the shared icon the Appearance tab uses', () => {
    // Identity, not resemblance: the submenu and the settings tab must render
    // the same component, or the two surfaces drift into different glyphs for
    // the same choice.
    expect(THEME_OPTIONS.map((option) => option.Icon)).toEqual([Sun, Moon, Monitor]);
  });

  test('pairs every value with a label and an icon', () => {
    for (const option of THEME_OPTIONS) {
      expect(option.label.length).toBeGreaterThan(0);
      expect(typeof option.Icon).toBe('function');
    }
  });
});
