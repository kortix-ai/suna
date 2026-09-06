import { beforeEach, describe, expect, test } from 'bun:test';

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

  test('navigate() to an ACCOUNT_GRADUATED id (groups, roles) routes to the account page', () => {
    // Regression: Members' Access tab's "Create one in Groups" / "Create one
    // in Roles" links call exactly this — before this branch existed,
    // `groups`/`roles` matched none of the checks and the click did nothing.
    const { nav, pushed } = navFor('members', 'acct-1');
    nav.navigate('groups');
    expect(pushed).toEqual(['/accounts/acct-1?tab=groups']);
  });

  test('roles resolves the same way', () => {
    const { nav, pushed } = navFor('members', 'acct-1');
    nav.navigate('roles');
    expect(pushed).toEqual(['/accounts/acct-1?tab=roles']);
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
