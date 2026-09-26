import { beforeEach, describe, expect, test } from 'bun:test';

import { EMPTY_SESSION_FILTER, useSessionFilterStore } from './session-filter-store';

const get = () => useSessionFilterStore.getState();

describe('session filter store (KRTX-250)', () => {
  beforeEach(() => get().reset());

  test('an unknown project has no filter', () => {
    expect(get().byProject['p1'] ?? EMPTY_SESSION_FILTER).toEqual({ query: '', statuses: [] });
  });

  test('query and statuses are kept per project', () => {
    get().setQuery('p1', 'login');
    get().toggleStatus('p1', 'failed');
    get().toggleStatus('p2', 'running');
    expect(get().byProject['p1']).toEqual({ query: 'login', statuses: ['failed'] });
    expect(get().byProject['p2']).toEqual({ query: '', statuses: ['running'] });
  });

  test('toggling a picked status removes it', () => {
    get().toggleStatus('p1', 'failed');
    get().toggleStatus('p1', 'running');
    get().toggleStatus('p1', 'failed');
    expect(get().byProject['p1']?.statuses).toEqual(['running']);
  });

  test('resetProject clears one project and leaves the others', () => {
    get().setQuery('p1', 'login');
    get().toggleStatus('p2', 'stopped');
    get().resetProject('p1');
    expect(get().byProject['p1']).toBeUndefined();
    expect(get().byProject['p2']?.statuses).toEqual(['stopped']);
  });

  test('reset (sign-out) clears every project', () => {
    get().setQuery('p1', 'login');
    get().reset();
    expect(get().byProject).toEqual({});
  });

  test('an unchanged query keeps the same state object (no re-render)', () => {
    get().setQuery('p1', 'login');
    const before = get().byProject;
    get().setQuery('p1', 'login');
    expect(get().byProject).toBe(before);
  });
});
