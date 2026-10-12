import { describe, expect, test } from 'bun:test';

import { parseSettingsTab, type SettingsTab } from '@/features/workspace/settings/settings-tabs';

/**
 * What is NOT covered here, and why.
 *
 * The menu's rows live inside a Radix `DropdownMenuContent`, which renders
 * nothing until the menu is open and then renders through a portal.
 * `apps/web` has no DOM harness — no jsdom, no testing-library — and
 * `renderToStaticMarkup` returns an empty string for portalled content
 * (`features/layout/user-menu.test.tsx` documents the same limit), so the
 * rows are not reachable from a unit test; the real menu is verified in a
 * browser. What IS reachable is the wiring the rows are built from, which is
 * what the source-scan tests below read. Comments are stripped before
 * matching, so the prose in the component cannot defeat an absence assertion.
 */
describe('AccountTopBar menu rows', () => {
  const source = async () => {
    const text = await Bun.file(new URL('./account-top-bar.tsx', import.meta.url)).text();
    return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  };

  /**
   * `/projects` and `/new` mount no `SettingsPanel`, so a row that pokes
   * `useSettingsPanelStore.openSettings()` would set state with no subscriber
   * and the click would be swallowed — the exact dead-store bug
   * `features/layout/user-menu.tsx` documents for its own rows. `/settings/<tab>`
   * is the account-scoped route that mounts the panel itself, so the row
   * navigates to it.
   */
  test('the menu holds a Settings row that navigates to /settings/profile', async () => {
    const code = await source();
    expect(code).toContain('<Link href="/settings/profile" prefetch>');
    expect(code).not.toContain('openSettings');
    expect(code).not.toContain('router.push');
  });

  /**
   * Every tab the rows build a URL from must be a segment
   * `app/[locale]/(app)/settings/[tab]/page.tsx` accepts, or the route silently
   * falls back to `STANDALONE_DEFAULT_SETTINGS_TAB` and the row opens a
   * different tab than it names (the same guard `user-menu.test.tsx` runs).
   */
  test('the tab the rows navigate to is a real /settings segment', async () => {
    const code = await source();
    const tabs = [...code.matchAll(/href="\/settings\/([a-z-]+)"/g)].map((m) => m[1]);
    expect(tabs.length).toBeGreaterThan(0);
    for (const tab of tabs) {
      expect(parseSettingsTab(tab)).toBe(tab as SettingsTab);
    }
  });

  /**
   * Log out ends something, so it keeps its own group after a separator — the
   * row order every other user menu in the app uses (settings first, log out
   * last, nothing below it: the last item in a menu is the one a slipped
   * pointer lands on).
   */
  test('the Settings row sits above the Log out row', async () => {
    const code = await source();
    expect(code).toContain('actions.settings');
    expect(code.indexOf('actions.settings')).toBeLessThan(code.indexOf('onSelect={onLogOut}'));
  });
});

/**
 * KRTX-1742: the notification bell sits in the trailing group, before the
 * account menu, on `/projects` and `/new`. It loads client-only, so the
 * static renders of those pages (project-selector.test.tsx) need no query
 * client or auth provider.
 */
describe('AccountTopBar notification bell', () => {
  const source = async () => {
    const text = await Bun.file(new URL('./account-top-bar.tsx', import.meta.url)).text();
    return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  };

  test('the bell renders before the account menu', async () => {
    const code = await source();
    expect(code).toContain('<NotificationBell />');
    expect(code.indexOf('<NotificationBell />')).toBeLessThan(code.indexOf('<DropdownMenu>'));
  });

  test('the bell is a client-only chunk', async () => {
    const code = await source();
    expect(code).toContain("import('@/features/notifications/notification-bell')");
    expect(code).toContain('{ ssr: false }');
  });
});
