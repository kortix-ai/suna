import { beforeEach, describe, expect, test } from 'bun:test';

import { DASHBOARD_TAB_ID, useTabStore, type Tab } from './tab-store';

/**
 * Characterization tests for the live tab surface: openTab, closeTab,
 * setActiveTab. They pin the current behavior and must pass unchanged
 * across refactors of the store's internals.
 */

/** Reset to the pristine initial state, the same way sign-out does. */
function resetTabStore(): void {
  useTabStore.setState(useTabStore.getInitialState(), true);
}

function tabInput(
  id: string,
  overrides: Partial<Omit<Tab, 'openedAt' | 'id'>> = {},
): Omit<Tab, 'openedAt'> {
  return { id, title: id, type: 'page', href: `/${id}`, ...overrides };
}

describe('openTab', () => {
  beforeEach(resetTabStore);

  test('creates the tab and activates it', () => {
    useTabStore.getState().openTab(tabInput('s1', { type: 'session' }));

    const state = useTabStore.getState();
    expect(state.tabs['s1']).toMatchObject({ id: 's1', type: 'session', title: 's1' });
    expect(state.activeTabId).toBe('s1');
    expect(state.tabOrder).toContain('s1');
  });

  test('keeps the pinned dashboard tab first in the order', () => {
    useTabStore.getState().openTab(tabInput('s1', { type: 'session' }));
    useTabStore.getState().openTab(tabInput('s2', { type: 'session' }));

    const state = useTabStore.getState();
    expect(state.tabOrder[0]).toBe(DASHBOARD_TAB_ID);
    expect(state.tabs[DASHBOARD_TAB_ID].pinned).toBe(true);
    expect(state.activeTabId).toBe('s2');
  });

  test('re-opening an existing tab activates it and keeps its openedAt', () => {
    useTabStore.getState().openTab(tabInput('s1'));
    const openedAt = useTabStore.getState().tabs['s1'].openedAt;

    useTabStore.getState().openTab(tabInput('s1', { title: 'renamed' }));

    const state = useTabStore.getState();
    expect(state.activeTabId).toBe('s1');
    expect(state.tabs['s1'].openedAt).toBe(openedAt);
    expect(state.tabs['s1'].title).toBe('renamed');
    expect(state.tabOrder.filter((id) => id === 's1')).toHaveLength(1);
  });
});

describe('closeTab', () => {
  beforeEach(resetTabStore);

  test('returns and activates the positional neighbour to the right', () => {
    useTabStore.getState().openTab(tabInput('a'));
    useTabStore.getState().openTab(tabInput('b'));
    useTabStore.getState().openTab(tabInput('c'));
    useTabStore.getState().setActiveTab('b');

    const next = useTabStore.getState().closeTab('b');

    expect(next).toBe('c');
    expect(useTabStore.getState().activeTabId).toBe('c');
    expect(useTabStore.getState().tabs['b']).toBeUndefined();
    expect(useTabStore.getState().tabOrder).not.toContain('b');
  });

  test('falls back to the left neighbour when the closed tab was rightmost', () => {
    useTabStore.getState().openTab(tabInput('a'));
    useTabStore.getState().openTab(tabInput('b'));

    const next = useTabStore.getState().closeTab('b');

    expect(next).toBe('a');
    expect(useTabStore.getState().activeTabId).toBe('a');
  });

  test('refuses to close the pinned dashboard tab', () => {
    useTabStore.getState().openTab(tabInput('a'));
    const activeBefore = useTabStore.getState().activeTabId;

    const next = useTabStore.getState().closeTab(DASHBOARD_TAB_ID);

    expect(next).toBe(activeBefore);
    expect(useTabStore.getState().tabs[DASHBOARD_TAB_ID]).toBeDefined();
    expect(useTabStore.getState().tabOrder).toContain(DASHBOARD_TAB_ID);
  });

  test('refuses to close a pinned non-dashboard tab', () => {
    useTabStore.getState().openTab(tabInput('a'));
    useTabStore
      .getState()
      .openTab(tabInput('pinned', { pinned: true, href: '/dashboard' }));
    const activeBefore = useTabStore.getState().activeTabId;

    const next = useTabStore.getState().closeTab('pinned');

    expect(next).toBe(activeBefore);
    expect(useTabStore.getState().tabs['pinned']).toBeDefined();
  });

  test('closing a background tab keeps the active tab', () => {
    useTabStore.getState().openTab(tabInput('a'));
    useTabStore.getState().openTab(tabInput('b'));

    const next = useTabStore.getState().closeTab('a');

    expect(next).toBe('b');
    expect(useTabStore.getState().activeTabId).toBe('b');
  });

  test('a sub-session tab activates its parent session tab', () => {
    useTabStore.getState().openTab(tabInput('parent', { type: 'session' }));
    useTabStore
      .getState()
      .openTab(tabInput('child', { type: 'session', parentSessionId: 'parent' }));
    expect(useTabStore.getState().activeTabId).toBe('child');

    const next = useTabStore.getState().closeTab('child');

    expect(next).toBe('parent');
    expect(useTabStore.getState().activeTabId).toBe('parent');
  });
});

describe('setActiveTab', () => {
  beforeEach(resetTabStore);

  test('activates an existing tab', () => {
    useTabStore.getState().openTab(tabInput('a'));
    useTabStore.getState().openTab(tabInput('b'));

    useTabStore.getState().setActiveTab('a');

    expect(useTabStore.getState().activeTabId).toBe('a');
  });

  test('ignores an unknown tab id', () => {
    useTabStore.getState().openTab(tabInput('a'));

    useTabStore.getState().setActiveTab('missing');

    expect(useTabStore.getState().activeTabId).toBe('a');
  });
});
