import { beforeEach, describe, expect, test } from 'bun:test';

import { useSessionFilterStore } from './session-filter-store';

beforeEach(() => {
  useSessionFilterStore.setState({ filterByProject: {} });
});

describe('useSessionFilterStore', () => {
  test('defaults to "all" for an unseen project', () => {
    expect(useSessionFilterStore.getState().filterByProject.p1 ?? 'all').toBe('all');
  });

  test('persists the chosen filter per project so it survives a remount', () => {
    useSessionFilterStore.getState().setFilter('p1', 'email');
    expect(useSessionFilterStore.getState().filterByProject.p1).toBe('email');
  });

  test('keeps each project filter independent', () => {
    useSessionFilterStore.getState().setFilter('p1', 'email');
    useSessionFilterStore.getState().setFilter('p2', 'slack');
    expect(useSessionFilterStore.getState().filterByProject.p1).toBe('email');
    expect(useSessionFilterStore.getState().filterByProject.p2).toBe('slack');
  });

  test('re-selecting the same filter is a no-op (no new object)', () => {
    useSessionFilterStore.getState().setFilter('p1', 'slack');
    const before = useSessionFilterStore.getState().filterByProject;
    useSessionFilterStore.getState().setFilter('p1', 'slack');
    expect(useSessionFilterStore.getState().filterByProject).toBe(before);
  });
});
