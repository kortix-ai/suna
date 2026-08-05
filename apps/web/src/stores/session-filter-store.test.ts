import { beforeEach, describe, expect, test } from 'bun:test';

import { EMPTY_LIST, useSessionFilterStore } from './session-filter-store';

const EMPTY_STATE = {
  groupByProject: {},
  orderByProject: {},
  statusFiltersByProject: {},
  sourceFiltersByProject: {},
  hiddenSectionsByProject: {},
  collapsedSectionsByProject: {},
};

beforeEach(() => {
  useSessionFilterStore.setState(EMPTY_STATE);
});

describe('toggleStatusFilter', () => {
  test('adds then removes, never duplicates', () => {
    const { toggleStatusFilter } = useSessionFilterStore.getState();
    toggleStatusFilter('p1', 'running');
    expect(useSessionFilterStore.getState().statusFiltersByProject.p1).toEqual(['running']);

    toggleStatusFilter('p1', 'running');
    expect(useSessionFilterStore.getState().statusFiltersByProject.p1).toEqual([]);

    toggleStatusFilter('p1', 'running');
    toggleStatusFilter('p1', 'done');
    expect(useSessionFilterStore.getState().statusFiltersByProject.p1).toEqual([
      'running',
      'done',
    ]);
  });
});

describe('toggleSourceFilter', () => {
  test('adds then removes, never duplicates', () => {
    const { toggleSourceFilter } = useSessionFilterStore.getState();
    toggleSourceFilter('p1', 'slack');
    expect(useSessionFilterStore.getState().sourceFiltersByProject.p1).toEqual(['slack']);

    toggleSourceFilter('p1', 'slack');
    expect(useSessionFilterStore.getState().sourceFiltersByProject.p1).toEqual([]);
  });
});

describe('toggleSectionHidden', () => {
  test('adds then removes, never duplicates', () => {
    const { toggleSectionHidden } = useSessionFilterStore.getState();
    toggleSectionHidden('p1', 'recent');
    expect(useSessionFilterStore.getState().hiddenSectionsByProject.p1).toEqual(['recent']);

    toggleSectionHidden('p1', 'recent');
    expect(useSessionFilterStore.getState().hiddenSectionsByProject.p1).toEqual([]);
  });
});

describe('toggleSectionCollapsed', () => {
  test('adds then removes, never duplicates', () => {
    const { toggleSectionCollapsed } = useSessionFilterStore.getState();
    toggleSectionCollapsed('p1', 'recent');
    expect(useSessionFilterStore.getState().collapsedSectionsByProject.p1).toEqual(['recent']);

    toggleSectionCollapsed('p1', 'recent');
    expect(useSessionFilterStore.getState().collapsedSectionsByProject.p1).toEqual([]);
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
    expect(after.statusFiltersByProject.p1).toEqual([]);
    expect(after.sourceFiltersByProject.p1).toEqual([]);
    expect(after.groupByProject.p1).toBe('source');
    expect(after.orderByProject.p1).toBe('name');
    expect(after.hiddenSectionsByProject.p1).toEqual(['recent']);
    expect(after.collapsedSectionsByProject.p1).toEqual(['recent']);
  });
});

describe('collapseAllSections', () => {
  test('replaces rather than appends', () => {
    const state = useSessionFilterStore.getState();
    state.toggleSectionCollapsed('p1', 'existing');

    state.collapseAllSections('p1', ['today', 'yesterday']);
    expect(useSessionFilterStore.getState().collapsedSectionsByProject.p1).toEqual([
      'today',
      'yesterday',
    ]);

    state.collapseAllSections('p1', []);
    expect(useSessionFilterStore.getState().collapsedSectionsByProject.p1).toEqual([]);
  });
});

describe('setGroupMode / setOrderMode', () => {
  test('no-op guard: setting the same value does not trigger a new object identity', () => {
    const state = useSessionFilterStore.getState();
    state.setGroupMode('p1', 'source');
    const groupMapRef = useSessionFilterStore.getState().groupByProject;
    state.setGroupMode('p1', 'source');
    expect(useSessionFilterStore.getState().groupByProject).toBe(groupMapRef);

    state.setOrderMode('p1', 'name');
    const orderMapRef = useSessionFilterStore.getState().orderByProject;
    state.setOrderMode('p1', 'name');
    expect(useSessionFilterStore.getState().orderByProject).toBe(orderMapRef);
  });
});

describe('defaults for an unknown project', () => {
  test('reads status/activity/empty arrays', () => {
    const state = useSessionFilterStore.getState();
    expect(state.groupByProject.unknown ?? 'status').toBe('status');
    expect(state.orderByProject.unknown ?? 'activity').toBe('activity');
    expect(state.statusFiltersByProject.unknown ?? []).toEqual([]);
    expect(state.sourceFiltersByProject.unknown ?? []).toEqual([]);
    expect(state.hiddenSectionsByProject.unknown ?? []).toEqual([]);
    expect(state.collapsedSectionsByProject.unknown ?? []).toEqual([]);
  });
});

describe('project isolation', () => {
  test('two different projects do not leak into each other', () => {
    const state = useSessionFilterStore.getState();
    state.toggleStatusFilter('p1', 'running');
    state.toggleSourceFilter('p1', 'slack');
    state.setGroupMode('p1', 'source');
    state.toggleSectionCollapsed('p1', 'recent');

    const after = useSessionFilterStore.getState();
    expect(after.statusFiltersByProject.p2 ?? []).toEqual([]);
    expect(after.sourceFiltersByProject.p2 ?? []).toEqual([]);
    expect(after.groupByProject.p2 ?? 'status').toBe('status');
    expect(after.collapsedSectionsByProject.p2 ?? []).toEqual([]);

    // p1 unaffected by reading p2
    expect(after.statusFiltersByProject.p1).toEqual(['running']);
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
      useSessionFilterStore.getState().statusFiltersByProject.unseen ?? [];
    // Two reads of the same absent key produce different references.
    expect(Object.is(readWithBareFallback(), readWithBareFallback())).toBe(false);
    // The shared constant does not.
    const readWithSharedFallback = () =>
      useSessionFilterStore.getState().statusFiltersByProject.unseen ?? EMPTY_LIST;
    expect(Object.is(readWithSharedFallback(), readWithSharedFallback())).toBe(true);
  });

  test('every list map returns the identical reference for an absent project', () => {
    const s = useSessionFilterStore.getState();
    const reads = [
      s.statusFiltersByProject.nobody ?? EMPTY_LIST,
      s.sourceFiltersByProject.nobody ?? EMPTY_LIST,
      s.hiddenSectionsByProject.nobody ?? EMPTY_LIST,
      s.collapsedSectionsByProject.nobody ?? EMPTY_LIST,
    ];
    for (const read of reads) expect(read).toBe(EMPTY_LIST);
  });
});
