import { describe, expect, test } from 'bun:test';

import { MonitorIcon, Moon, Sun } from '@phosphor-icons/react';

import { parseSettingsTab, type SettingsTab } from '@/features/workspace/settings/settings-tabs';
import { useSettingsPanelStore } from '@/stores/settings-panel-store';

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
    expect(THEME_OPTIONS.map((option) => option.Icon)).toEqual([Sun, Moon, MonitorIcon]);
  });

  test('pairs every value with a label and an icon', () => {
    for (const option of THEME_OPTIONS) {
      expect(option.label.length).toBeGreaterThan(0);
      // Renderable, not necessarily a plain function. These moved from local
      // SVG components to Phosphor, and a `forwardRef` component is an OBJECT
      // carrying `$$typeof` — `typeof === 'function'` would fail every icon in
      // the library while the component is perfectly valid.
      expect(['function', 'object']).toContain(typeof option.Icon);
      expect(option.Icon).toBeTruthy();
    }
  });
});

/**
 * `openUserSettings` and the billing row's onClick both live inside
 * `UserMenu`, unexported, and `renderToStaticMarkup` cannot reach a portalled
 * `DropdownMenuContent` anyway — see this file's top. So the reachable proof
 * of what a row DOES is the source text, which is what the source-scan tests
 * below read.
 *
 * The two store tests that open this block are NOT that proof and never were:
 * they invoke the store themselves, so they pass whatever the menu is wired
 * to. They are kept, retitled to say what they actually cover — that
 * `openSettings(tab)` sets `open` and `tab`, the contract the OTHER settings
 * mounts (`project-shell.tsx:195`, `standalone-settings-route.tsx:113`) rely
 * on. `UserMenu` itself no longer touches the store at all; see
 * `openUserSettings`' header comment in the component.
 */
describe('user menu settings entry points', () => {
  test('the settings panel store opens on the profile tab when asked for it', () => {
    useSettingsPanelStore.getState().openSettings('profile');
    expect(useSettingsPanelStore.getState().open).toBe(true);
    expect(useSettingsPanelStore.getState().tab).toBe('profile');
  });

  test('the settings panel store opens on the billing tab when asked for it', () => {
    useSettingsPanelStore.getState().openSettings('billing');
    expect(useSettingsPanelStore.getState().tab).toBe('billing');
  });

  /**
   * The two tests above invoke the store directly, so they pass no matter
   * which tab the menu actually passes — they could not fail when the row
   * regressed to `openUserSettings('general')` (Workspace → General, a
   * project-scoped tab that `ACCOUNT_SCOPED_SETTINGS_TABS` filters out with
   * no project open). With no DOM harness the only reachable proof of the
   * call TARGET is the source itself, so this reads the file and asserts both
   * directions: the correct tab is present AND the wrong one is absent.
   */
  test('the user settings row is wired to `profile`, not the project-scoped `general`', async () => {
    const source = await Bun.file(new URL('./user-menu.tsx', import.meta.url)).text();
    const calls = [...source.matchAll(/openUserSettings\('([^']+)'\)/g)].map((m) => m[1]);
    expect(calls).toContain('profile');
    expect(calls).not.toContain('general');
  });

  /**
   * The rows must NAVIGATE, not poke the store.
   *
   * `UserMenu`'s only mount is the app header
   * (`features/layout/app-header.tsx:108`), rendered only by
   * `app/(app)/accounts/layout.tsx:26`. `SettingsPanel` has exactly two mounts
   * (`project-layout/project-shell.tsx:195`,
   * `workspace/settings/standalone-settings-route.tsx:113`) and neither is in
   * the `/accounts` tree. So `openSettings(tab)` from here set `open: true`
   * with no subscriber and the Settings and Billing rows did NOTHING when
   * clicked. `/settings/<tab>` is the account-scoped route that mounts the
   * panel itself.
   *
   * Comments are stripped before matching, so the prose above — which names
   * `useSettingsPanelStore` and `openSettings` repeatedly — cannot defeat the
   * absence assertion.
   */
  test('the settings and billing rows navigate to /settings/<tab> instead of writing to the store', async () => {
    const source = await Bun.file(new URL('./user-menu.tsx', import.meta.url)).text();
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

    expect(code).toContain('router.push(`/settings/${tab}`)');
    // The store is unreachable from this mount — no call, and no import left
    // behind to make one look reachable.
    expect(code).not.toContain('useSettingsPanelStore');

    const calls = [...code.matchAll(/openUserSettings\('([^']+)'\)/g)].map((m) => m[1]);
    expect(calls).toContain('profile');
    expect(calls).toContain('billing');
  });

  /**
   * Every tab these rows build a URL from must be a segment
   * `app/(app)/settings/[tab]/page.tsx` accepts, or the route silently falls
   * back to `STANDALONE_DEFAULT_SETTINGS_TAB` and Billing opens on Profile.
   */
  test('every tab the rows navigate to is a real /settings segment', async () => {
    const source = await Bun.file(new URL('./user-menu.tsx', import.meta.url)).text();
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const calls = [...code.matchAll(/openUserSettings\('([^']+)'\)/g)].map((m) => m[1]);

    expect(calls.length).toBeGreaterThan(0);
    for (const tab of calls) {
      expect(parseSettingsTab(tab)).toBe(tab as SettingsTab);
    }
  });
});
