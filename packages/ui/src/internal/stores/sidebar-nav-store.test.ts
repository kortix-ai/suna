import { describe, expect, test } from 'bun:test';

import {
  SIDEBAR_NAV_DEFAULTS,
  type SidebarNavEntry,
  migrateSidebarNav,
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
      { id: 'customize', visibility: 'always' },
      { id: 'apps', visibility: 'always' },
      { id: 'rooms', visibility: 'never' },
    ];
    expect(normalizeSidebarNav(saved)).toEqual(saved);
  });

  test('drops unknown ids and duplicates, and re-adds missing rows at their default slot', () => {
    const out = normalizeSidebarNav([
      { id: 'files', visibility: 'always' },
      { id: 'settings', visibility: 'always' },
      { id: 'files', visibility: 'never' },
    ]);
    expect(ids(out)).toEqual(['customize', 'files', 'apps', 'rooms']);
    expect(out.find((e) => e.id === 'files')?.visibility).toBe('always');
  });

  test('a layout saved while Review and Reminders were sidebar rows drops both', () => {
    const out = normalizeSidebarNav([
      { id: 'review', visibility: 'always' },
      { id: 'reminders', visibility: 'active' },
      { id: 'apps', visibility: 'never' },
    ]);
    expect(out).toEqual([
      { id: 'customize', visibility: 'always' },
      { id: 'files', visibility: 'always' },
      { id: 'apps', visibility: 'never' },
      { id: 'rooms', visibility: 'never' },
    ]);
  });

  test('Rooms sits in the More menu until the person pins it', () => {
    expect(normalizeSidebarNav(null).find((e) => e.id === 'rooms')?.visibility).toBe('never');
    expect(
      normalizeSidebarNav([{ id: 'rooms', visibility: 'always' }]).find((e) => e.id === 'rooms')?.visibility,
    ).toBe('always');
  });

  test('the retired "active" visibility falls back to the default', () => {
    const out = normalizeSidebarNav([{ id: 'files', visibility: 'active' }]);
    expect(out.find((e) => e.id === 'files')?.visibility).toBe('always');
  });
});

describe('migrateSidebarNav', () => {
  test('a v1 layout moves Rooms into More and keeps every other choice', () => {
    const v1 = { items: [{ id: 'files', visibility: 'never' }, { id: 'rooms', visibility: 'always' }] };
    const out = migrateSidebarNav(v1, 1).items;
    expect(out.find((e) => e.id === 'rooms')?.visibility).toBe('never');
    expect(out.find((e) => e.id === 'files')?.visibility).toBe('never');
  });

  test('a v2 layout keeps a pinned Rooms row', () => {
    const v2 = { items: [{ id: 'rooms', visibility: 'always' }] };
    expect(migrateSidebarNav(v2, 2).items.find((e) => e.id === 'rooms')?.visibility).toBe('always');
  });
});

describe('moveSidebarNavItem', () => {
  test('moves a row one step and stops at the edges', () => {
    const items = normalizeSidebarNav(null);
    expect(ids(moveSidebarNavItem(items, 'files', -1)).slice(0, 2)).toEqual(['files', 'customize']);
    expect(ids(moveSidebarNavItem(items, 'customize', -1))).toEqual(ids(items));
    expect(ids(moveSidebarNavItem(items, 'rooms', 1))).toEqual(ids(items));
  });
});

describe('useSidebarNavStore', () => {
  test('setItems, setVisibility and reset', () => {
    const store = useSidebarNavStore.getState();
    store.setItems(
      (['files', 'apps', 'customize', 'rooms'] as const).map((id) => ({
        id,
        visibility: 'always' as const,
      })),
    );
    expect(ids(useSidebarNavStore.getState().items)).toEqual(['files', 'apps', 'customize', 'rooms']);
    store.setVisibility('apps', 'never');
    store.setVisibility('files', 'active' as never); // ignored: not a visibility
    const items = useSidebarNavStore.getState().items;
    expect(items.find((e) => e.id === 'apps')?.visibility).toBe('never');
    expect(items.find((e) => e.id === 'files')?.visibility).toBe('always');
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
    const remote = [{ id: 'files', visibility: 'never' }];
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
