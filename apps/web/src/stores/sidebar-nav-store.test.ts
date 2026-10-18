import { describe, expect, test } from 'bun:test';

import {
  SIDEBAR_NAV_DEFAULTS,
  type SidebarNavEntry,
  moveSidebarNavItem,
  normalizeSidebarNav,
  resolveSidebarNav,
  useSidebarNavStore,
} from './sidebar-nav-store';

const ids = (items: { id: string }[]) => items.map((e) => e.id);

describe('normalizeSidebarNav', () => {
  test('nothing saved yields the defaults', () => {
    expect(normalizeSidebarNav(undefined)).toEqual([...SIDEBAR_NAV_DEFAULTS]);
    expect(normalizeSidebarNav('garbage')).toEqual([...SIDEBAR_NAV_DEFAULTS]);
  });

  test('keeps a saved order and visibility', () => {
    const saved: SidebarNavEntry[] = [
      { id: 'files', visibility: 'never' },
      { id: 'reminders', visibility: 'active' },
      { id: 'customize', visibility: 'always' },
      { id: 'apps', visibility: 'always' },
    ];
    expect(normalizeSidebarNav(saved)).toEqual(saved);
  });

  test('drops unknown ids and duplicates, and re-adds missing rows at their default slot', () => {
    const out = normalizeSidebarNav([
      { id: 'files', visibility: 'always' },
      { id: 'settings', visibility: 'always' },
      { id: 'files', visibility: 'never' },
    ]);
    expect(ids(out)).toEqual(['customize', 'apps', 'reminders', 'files']);
    expect(out.find((e) => e.id === 'files')?.visibility).toBe('always');
  });

  test('a layout saved while Review was a sidebar row drops it', () => {
    const out = normalizeSidebarNav([
      { id: 'review', visibility: 'always' },
      { id: 'apps', visibility: 'never' },
    ]);
    expect(out).toEqual([
      { id: 'customize', visibility: 'always' },
      { id: 'apps', visibility: 'never' },
      { id: 'reminders', visibility: 'active' },
      { id: 'files', visibility: 'always' },
    ]);
  });

  test('a row without an activity signal cannot be "active"', () => {
    const out = normalizeSidebarNav([{ id: 'files', visibility: 'active' }]);
    expect(out.find((e) => e.id === 'files')?.visibility).toBe('always');
  });
});

describe('moveSidebarNavItem', () => {
  test('moves a row one step and stops at the edges', () => {
    const items = normalizeSidebarNav(null);
    expect(ids(moveSidebarNavItem(items, 'apps', -1)).slice(0, 2)).toEqual(['apps', 'customize']);
    expect(ids(moveSidebarNavItem(items, 'customize', -1))).toEqual(ids(items));
    expect(ids(moveSidebarNavItem(items, 'files', 1))).toEqual(ids(items));
  });
});

describe('useSidebarNavStore', () => {
  test('setItems, setVisibility and reset', () => {
    const store = useSidebarNavStore.getState();
    store.setItems(
      (['files', 'reminders', 'apps', 'customize'] as const).map((id) => ({
        id,
        visibility: 'always' as const,
      })),
    );
    expect(ids(useSidebarNavStore.getState().items)).toEqual([
      'files',
      'reminders',
      'apps',
      'customize',
    ]);
    store.setVisibility('reminders', 'active');
    store.setVisibility('apps', 'active'); // ignored: Apps has no activity signal
    const items = useSidebarNavStore.getState().items;
    expect(items.find((e) => e.id === 'reminders')?.visibility).toBe('active');
    expect(items.find((e) => e.id === 'apps')?.visibility).toBe('always');
    store.reset();
    expect(useSidebarNavStore.getState().items).toEqual([...SIDEBAR_NAV_DEFAULTS]);
  });
});

describe('resolveSidebarNav', () => {
  const custom = normalizeSidebarNav([
    { id: 'files', visibility: 'always' },
    { id: 'apps', visibility: 'never' },
  ]);

  test('the account layout wins over the local one and is not pushed back', () => {
    const remote = [{ id: 'reminders', visibility: 'never' }];
    expect(resolveSidebarNav(remote, custom)).toEqual({
      items: normalizeSidebarNav(remote),
      push: false,
    });
  });

  test('no account layout: a customized local layout is kept and pushed once', () => {
    expect(resolveSidebarNav(undefined, custom)).toEqual({ items: custom, push: true });
  });

  test('no account layout and an untouched local one: nothing to push', () => {
    expect(resolveSidebarNav(null, SIDEBAR_NAV_DEFAULTS)).toEqual({
      items: [...SIDEBAR_NAV_DEFAULTS],
      push: false,
    });
  });
});
