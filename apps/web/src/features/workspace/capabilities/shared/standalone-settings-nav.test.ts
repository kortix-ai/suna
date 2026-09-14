import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { useSettingsPanelStore } from '@/stores/settings-panel-store';

import { buildStandaloneCapabilityNav } from './standalone-settings-nav';

/**
 * `useStandaloneCapabilityNav`'s pure half — the adapter behind Models,
 * Secrets, and Members (`members-page.tsx`). Mirrors
 * `project-settings-page.test.ts`'s `navFor` harness for its sibling adapter;
 * see that file's header for why `navigate` writes through the real store
 * instead of a mock.
 */
function navFor(activeTab = 'members', accountId?: string) {
  const pushed: string[] = [];
  const nav = buildStandaloneCapabilityNav({
    projectId: 'p1',
    activeTab,
    membersTab: useSettingsPanelStore.getState().membersTab,
    accountId,
    navigateTo: (href) => pushed.push(href),
  });
  return { nav, pushed };
}

/**
 * A fake browser, because the account-hub branch below opens a MODAL rather
 * than navigating: the hub has no route, so its destination is `?accountId=`
 * written onto the current page with `history.pushState`
 * (`stores/account-panel-store.ts`). `pushed` therefore stays empty for those
 * ids, and `hubUrl()` is what proves the click went somewhere.
 */
const originalWindow = (globalThis as { window?: unknown }).window;
let historyUrl = '/projects/p1';

function installFakeBrowser() {
  historyUrl = '/projects/p1';
  (globalThis as { window?: unknown }).window = {
    location: { pathname: '/projects/p1', search: '' },
    history: {
      pushState: (_s: unknown, _t: unknown, url: string) => {
        historyUrl = url;
      },
      replaceState: (_s: unknown, _t: unknown, url: string) => {
        historyUrl = url;
      },
      back: () => {},
    },
  };
}

function hubUrl() {
  return historyUrl;
}

afterEach(() => {
  if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = originalWindow;
});

beforeEach(() => {
  useSettingsPanelStore.setState({ open: false, membersTab: 'people' });
});

describe('buildStandaloneCapabilityNav', () => {
  test('navigate() to a sibling top-level Customize tab routes there', () => {
    const { nav, pushed } = navFor('members');
    nav.navigate('secrets');
    expect(pushed).toEqual(['/projects/p1/customize/secrets']);
  });

  test('navigate() to the page it is already on is a no-op, not a self-route', () => {
    const { nav, pushed } = navFor('members');
    nav.navigate('members');
    expect(pushed).toEqual([]);
  });

  test('navigate() to an ACCOUNT_GRADUATED id (groups, roles) opens the account hub', () => {
    // Regression: Members' Access tab's "Create one in Groups" / "Create one
    // in Roles" links call exactly this — before this branch existed,
    // `groups`/`roles` matched none of the checks and the click did nothing.
    installFakeBrowser();
    const { nav, pushed } = navFor('members', 'acct-1');
    nav.navigate('groups');
    expect(pushed).toEqual([]);
    expect(hubUrl()).toBe('/projects/p1?accountId=acct-1&accountTab=groups');
  });

  test('roles resolves the same way', () => {
    installFakeBrowser();
    const { nav, pushed } = navFor('members', 'acct-1');
    nav.navigate('roles');
    expect(pushed).toEqual([]);
    expect(hubUrl()).toBe('/projects/p1?accountId=acct-1&accountTab=roles');
  });

  test('an ACCOUNT_GRADUATED id with no accountId yet does nothing, not a broken URL', () => {
    const { nav, pushed } = navFor('members');
    nav.navigate('groups');
    expect(pushed).toEqual([]);
    expect(useSettingsPanelStore.getState().open).toBe(false);
  });

  test('navigate() to a tab that stayed in the overlay opens the overlay, not a route', () => {
    const { nav, pushed } = navFor('members', 'acct-1');
    nav.navigate('preferences');
    expect(pushed).toEqual([]);
    expect(useSettingsPanelStore.getState().open).toBe(true);
    expect(useSettingsPanelStore.getState().tab).toBe('preferences');
  });

  test('an explicit membersTab opt writes the intent to the live store', () => {
    const { nav } = navFor('sandbox');
    nav.navigate('members', { membersTab: 'invite' });
    expect(useSettingsPanelStore.getState().membersTab).toBe('invite');
  });
});
