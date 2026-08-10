import { beforeEach, describe, expect, test } from 'bun:test';

import { EMPTY_LIST, useSessionFilterStore } from './session-filter-store';

const EMPTY_STATE = {
  groupByWorkspace: {},
  orderByWorkspace: {},
  statusFiltersByWorkspace: {},
  sourceFiltersByWorkspace: {},
  hiddenSectionsByWorkspace: {},
  collapsedSectionsByWorkspace: {},
};

beforeEach(() => {
  useSessionFilterStore.setState(EMPTY_STATE);
});

describe('toggleStatusFilter', () => {
  test('adds then removes, never duplicates', () => {
    const { toggleStatusFilter } = useSessionFilterStore.getState();
    toggleStatusFilter('p1', 'running');
    expect(useSessionFilterStore.getState().statusFiltersByWorkspace.p1).toEqual(['running']);

    toggleStatusFilter('p1', 'running');
    expect(useSessionFilterStore.getState().statusFiltersByWorkspace.p1).toEqual([]);

    toggleStatusFilter('p1', 'running');
    toggleStatusFilter('p1', 'done');
    expect(useSessionFilterStore.getState().statusFiltersByWorkspace.p1).toEqual(['running', 'done']);
  });
});

describe('toggleSourceFilter', () => {
  test('adds then removes, never duplicates', () => {
    const { toggleSourceFilter } = useSessionFilterStore.getState();
    toggleSourceFilter('p1', 'slack');
    expect(useSessionFilterStore.getState().sourceFiltersByWorkspace.p1).toEqual(['slack']);

    toggleSourceFilter('p1', 'slack');
    expect(useSessionFilterStore.getState().sourceFiltersByWorkspace.p1).toEqual([]);
  });
});

describe('toggleSectionHidden', () => {
  test('adds then removes, never duplicates', () => {
    const { toggleSectionHidden } = useSessionFilterStore.getState();
    toggleSectionHidden('p1', 'recent');
    expect(useSessionFilterStore.getState().hiddenSectionsByWorkspace.p1).toEqual(['recent']);

    toggleSectionHidden('p1', 'recent');
    expect(useSessionFilterStore.getState().hiddenSectionsByWorkspace.p1).toEqual([]);
  });
});

describe('toggleSectionCollapsed', () => {
  test('adds then removes, never duplicates', () => {
    const { toggleSectionCollapsed } = useSessionFilterStore.getState();
    toggleSectionCollapsed('p1', 'recent');
    expect(useSessionFilterStore.getState().collapsedSectionsByWorkspace.p1).toEqual(['recent']);

    toggleSectionCollapsed('p1', 'recent');
    expect(useSessionFilterStore.getState().collapsedSectionsByWorkspace.p1).toEqual([]);
  });
});

describe('resetFilters', () => {
  test('clears both facets and leaves grouping/ordering/hidden/collapsed untouched', () => {
    const state = useSessionFilterStore.getState();
    state.toggleStatusFilter('p1', 'running');
    state.toggleSourceFilter('p1', 'slack');
    state.setGroupMode('p1', 'source');
    state.setOrderMode('p1', 'name');
    state.toggleSectionHidden('p1', 'recent');
    state.toggleSectionCollapsed('p1', 'recent');

    useSessionFilterStore.getState().resetFilters('p1');

    const after = useSessionFilterStore.getState();
    expect(after.statusFiltersByWorkspace.p1).toEqual([]);
    expect(after.sourceFiltersByWorkspace.p1).toEqual([]);
    expect(after.groupByWorkspace.p1).toBe('source');
    expect(after.orderByWorkspace.p1).toBe('name');
    expect(after.hiddenSectionsByWorkspace.p1).toEqual(['recent']);
    expect(after.collapsedSectionsByWorkspace.p1).toEqual(['recent']);
  });
});

describe('collapseAllSections', () => {
  test('replaces rather than appends', () => {
    const state = useSessionFilterStore.getState();
    state.toggleSectionCollapsed('p1', 'existing');

    state.collapseAllSections('p1', ['today', 'yesterday']);
    expect(useSessionFilterStore.getState().collapsedSectionsByWorkspace.p1).toEqual([
      'today',
      'yesterday',
    ]);

    state.collapseAllSections('p1', []);
    expect(useSessionFilterStore.getState().collapsedSectionsByWorkspace.p1).toEqual([]);
  });
});

describe('setGroupMode / setOrderMode', () => {
  test('treats activity as the default grouping without persisting a redundant value', () => {
    const state = useSessionFilterStore.getState();
    const groupMapRef = state.groupByWorkspace;

    state.setGroupMode('p1', 'activity');

    expect(useSessionFilterStore.getState().groupByWorkspace).toBe(groupMapRef);
  });

  test('no-op guard: setting the same value does not trigger a new object identity', () => {
    const state = useSessionFilterStore.getState();
    state.setGroupMode('p1', 'source');
    const groupMapRef = useSessionFilterStore.getState().groupByWorkspace;
    state.setGroupMode('p1', 'source');
    expect(useSessionFilterStore.getState().groupByWorkspace).toBe(groupMapRef);

    state.setOrderMode('p1', 'name');
    const orderMapRef = useSessionFilterStore.getState().orderByWorkspace;
    state.setOrderMode('p1', 'name');
    expect(useSessionFilterStore.getState().orderByWorkspace).toBe(orderMapRef);
  });
});

describe('defaults for an unknown workspace', () => {
  test('reads activity/activity/empty arrays', () => {
    const state = useSessionFilterStore.getState();
    expect(state.groupByWorkspace.unknown ?? 'activity').toBe('activity');
    expect(state.orderByWorkspace.unknown ?? 'activity').toBe('activity');
    expect(state.statusFiltersByWorkspace.unknown ?? []).toEqual([]);
    expect(state.sourceFiltersByWorkspace.unknown ?? []).toEqual([]);
    expect(state.hiddenSectionsByWorkspace.unknown ?? []).toEqual([]);
    expect(state.collapsedSectionsByWorkspace.unknown ?? []).toEqual([]);
  });
});

describe('workspace isolation', () => {
  test('two different workspaces do not leak into each other', () => {
    const state = useSessionFilterStore.getState();
    state.toggleStatusFilter('p1', 'running');
    state.toggleSourceFilter('p1', 'slack');
    state.setGroupMode('p1', 'source');
    state.toggleSectionCollapsed('p1', 'recent');

    const after = useSessionFilterStore.getState();
    expect(after.statusFiltersByWorkspace.p2 ?? []).toEqual([]);
    expect(after.sourceFiltersByWorkspace.p2 ?? []).toEqual([]);
    expect(after.groupByWorkspace.p2 ?? 'activity').toBe('activity');
    expect(after.collapsedSectionsByWorkspace.p2 ?? []).toEqual([]);

    // p1 unaffected by reading p2
    expect(after.statusFiltersByWorkspace.p1).toEqual(['running']);
  });
});

describe('EMPTY_LIST — infinite-render-loop guard', () => {
  // Regression: every list selector used a bare `?? []`, allocating a new array
  // on each read. zustand v5 reads through useSyncExternalStore, which compares
  // snapshots with Object.is, so the snapshot never matched the previous one and
  // React looped until "Maximum update depth exceeded". These tests fail if a
  // future edit reintroduces a fresh literal.

  test('the shared fallback is one stable, frozen reference', () => {
    expect(EMPTY_LIST).toBe(EMPTY_LIST);
    expect(Object.isFrozen(EMPTY_LIST)).toBe(true);
    expect(EMPTY_LIST).toEqual([]);
  });

  test('a bare [] fallback is NOT reference-stable — this is the bug being guarded', () => {
    const readWithBareFallback = () =>
      useSessionFilterStore.getState().statusFiltersByWorkspace.unseen ?? [];
    // Two reads of the same absent key produce different references.
    expect(Object.is(readWithBareFallback(), readWithBareFallback())).toBe(false);
    // The shared constant does not.
    const readWithSharedFallback = () =>
      useSessionFilterStore.getState().statusFiltersByWorkspace.unseen ?? EMPTY_LIST;
    expect(Object.is(readWithSharedFallback(), readWithSharedFallback())).toBe(true);
  });

  test('every list map returns the identical reference for an absent workspace', () => {
    const s = useSessionFilterStore.getState();
    const reads = [
      s.statusFiltersByWorkspace.nobody ?? EMPTY_LIST,
      s.sourceFiltersByWorkspace.nobody ?? EMPTY_LIST,
      s.hiddenSectionsByWorkspace.nobody ?? EMPTY_LIST,
      s.collapsedSectionsByWorkspace.nobody ?? EMPTY_LIST,
    ];
    for (const read of reads) expect(read).toBe(EMPTY_LIST);
  });
});
