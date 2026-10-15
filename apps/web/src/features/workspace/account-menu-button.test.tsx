import { afterEach, describe, expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { parseSettingsTab, type SettingsTab } from '@/features/workspace/settings/settings-tabs';

/**
 * The menu's rows live inside a Radix `DropdownMenuContent`, which renders
 * nothing until the menu is open and then renders through a portal.
 * `apps/web` has no DOM harness — no jsdom, no testing-library — and
 * `renderToStaticMarkup` returns an empty string for portalled content
 * (`features/layout/user-menu.test.tsx` documents the same limit), so the rows
 * are not reachable from a unit test; the real menu is verified in a browser
 * (`tests/e2e/specs/44-account-chip-ui.spec.ts`). What IS reachable is the
 * wiring the rows are built from, which is what the source-scan tests below
 * read. Comments are stripped before matching, so the prose in the component
 * cannot defeat an absence assertion.
 */
describe('AccountMenuButton menu rows', () => {
  const source = async () => {
    const text = await Bun.file(new URL('./account-menu-button.tsx', import.meta.url)).text();
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
    expect(code.indexOf('actions.settings')).toBeLessThan(code.indexOf('onSelect={() => {'));
    expect(code).toContain('actions.logOut');
  });

  /**
   * Self-contained (KRTX-2145): the chip reads the session itself instead of
   * threading `email` / `name` / `signingOut` / `onLogOut` through every page
   * that renders it. The sign-out goes through `performSignOut`, the same
   * sequence every other exit uses — a bare `signOut()` neither awaited nor
   * navigated and left the user on the page.
   */
  test('the chip signs out through performSignOut, driven by its own state', async () => {
    const code = await source();
    expect(code).toContain("from '@/lib/auth/perform-sign-out'");
    expect(code).toContain('void performSignOut()');
    expect(code).toContain('useAuth()');
  });
});

/**
 * `renderToStaticMarkup` runs the component's hooks, and the chip reads
 * `useAuth()` — so the render tests stand in a stub provider whose user the
 * tests swap through `stubbedUser` (one module mock, mutable fixture: the same
 * stand-in pattern `app/[locale]/(auth)` tests use).
 */
let stubbedUser: { email: string; user_metadata: Record<string, string> } | null = null;

mock.module('@/features/providers/auth-provider', () => ({
  useAuth: () => ({ user: stubbedUser, session: null, isLoading: false }),
}));

describe('AccountMenuButton render', () => {
  afterEach(() => {
    stubbedUser = null;
  });

  test('the trigger names who is signed in', async () => {
    stubbedUser = { email: 'ada@example.test', user_metadata: { name: 'Ada Lovelace' } };
    const { AccountMenuButton } = await import('./account-menu-button');
    const html = renderToStaticMarkup(createElement(AccountMenuButton, {}));
    // The visible identity: the person's name when there is one, else email.
    expect(html).toContain('Ada Lovelace');
    expect(html).toContain('Logged in as');
    expect(html).toContain('aria-label="Logged in as Ada Lovelace"');
  });

  test('without a name the email is the identity; without a session the fallback label', async () => {
    stubbedUser = { email: 'ada@example.test', user_metadata: {} };
    const { AccountMenuButton } = await import('./account-menu-button');
    expect(renderToStaticMarkup(createElement(AccountMenuButton, {}))).toContain(
      'ada@example.test',
    );

    stubbedUser = null;
    expect(renderToStaticMarkup(createElement(AccountMenuButton, {}))).toContain('>Account<');
  });

  /**
   * `embedded` is the marker the project shell's floating corner reads (the
   * `:has([data-kx-account-owner])` rule in globals.css): a view that renders
   * its own chip must announce it, so exactly one account control shows per
   * view. The floating corner itself renders the chip WITHOUT the marker — a
   * corner chip that marked itself would hide itself forever.
   */
  test('the embedded marker is stamped only when asked', async () => {
    stubbedUser = { email: 'ada@example.test', user_metadata: {} };
    const { AccountMenuButton } = await import('./account-menu-button');
    const embedded = renderToStaticMarkup(createElement(AccountMenuButton, { embedded: true }));
    expect(embedded).toContain('data-kx-account-owner');
    const floating = renderToStaticMarkup(createElement(AccountMenuButton, {}));
    expect(floating).not.toContain('data-kx-account-owner');
  });
});
