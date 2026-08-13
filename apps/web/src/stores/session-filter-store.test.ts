/**
 * The surface contract: the sidebar and the sessions page share this store's
 * shape and its menu, but not their state — and the page starts out matching
 * the sidebar rather than at raw defaults.
 *
 * Both halves matter and neither is visible from a type signature, so they are
 * pinned here: inherit until first write, own it forever after.
 */
import { beforeEach, describe, expect, test } from 'bun:test';

import {
  selectCollapsedSections,
  selectGroupMode,
  selectHiddenSections,
  selectOrderMode,
  selectSourceFilters,
  selectStatusFilters,
  useSessionFilterStore,
} from './session-filter-store';

const P = 'project-1';
const read = <T,>(selector: (s: ReturnType<typeof useSessionFilterStore.getState>) => T): T =>
  selector(useSessionFilterStore.getState());

beforeEach(() => {
  useSessionFilterStore.setState({
    groupByProject: {},
    orderByProject: {},
    statusFiltersByProject: {},
    sourceFiltersByProject: {},
    hiddenSectionsByProject: {},
    collapsedSectionsByProject: {},
  });
});

describe('defaults', () => {
  test('both surfaces start on the same defaults', () => {
    expect(read(selectGroupMode(P, 'sidebar'))).toBe('activity');
    expect(read(selectGroupMode(P, 'page'))).toBe('activity');
    expect(read(selectOrderMode(P, 'page'))).toBe('activity');
    expect(read(selectStatusFilters(P, 'page'))).toEqual([]);
  });

  test('the surface argument defaults to the sidebar', () => {
    useSessionFilterStore.getState().setGroupMode(P, 'source');
    expect(read(selectGroupMode(P))).toBe('source');
    expect(read(selectGroupMode(P, 'sidebar'))).toBe('source');
  });
});

describe('the page inherits the sidebar until it chooses for itself', () => {
  test('a sidebar grouping shows through on the page', () => {
    useSessionFilterStore.getState().setGroupMode(P, 'source', 'sidebar');
    expect(read(selectGroupMode(P, 'page'))).toBe('source');
  });

  test('a sidebar filter shows through on the page', () => {
    useSessionFilterStore.getState().toggleStatusFilter(P, 'failed', 'sidebar');
    expect(read(selectStatusFilters(P, 'page'))).toEqual(['failed']);
  });

  test('collapsed sections are the ONE thing the page does not inherit', () => {
    // Folding "Older" away in the narrow sidebar must not open the full
    // sessions page with its sections already shut. Every section starts
    // expanded there.
    useSessionFilterStore.getState().toggleSectionCollapsed(P, 'older', 'sidebar');

    expect(read(selectCollapsedSections(P, 'sidebar'))).toEqual(['older']);
    expect(read(selectCollapsedSections(P, 'page'))).toEqual([]);
  });

  test('a page collapse starts from the page list, not the sidebar list', () => {
    useSessionFilterStore.getState().toggleSectionCollapsed(P, 'older', 'sidebar');
    // Collapsing the same section on the page must ADD it there, not toggle the
    // inherited entry back off and leave the page unchanged.
    useSessionFilterStore.getState().toggleSectionCollapsed(P, 'older', 'page');

    expect(read(selectCollapsedSections(P, 'page'))).toEqual(['older']);
    expect(read(selectCollapsedSections(P, 'sidebar'))).toEqual(['older']);
  });

  test('once the page chooses, it stops following the sidebar', () => {
    useSessionFilterStore.getState().setGroupMode(P, 'source', 'sidebar');
    useSessionFilterStore.getState().setGroupMode(P, 'status', 'page');

    expect(read(selectGroupMode(P, 'page'))).toBe('status');
    expect(read(selectGroupMode(P, 'sidebar'))).toBe('source');

    // A later sidebar change must not reach back into the page.
    useSessionFilterStore.getState().setGroupMode(P, 'none', 'sidebar');
    expect(read(selectGroupMode(P, 'page'))).toBe('status');
  });

  test('a page toggle starts from the INHERITED value, not from empty', () => {
    useSessionFilterStore.getState().toggleStatusFilter(P, 'failed', 'sidebar');
    // The page is showing ['failed']; adding 'running' there must yield both,
    // not drop the inherited one on the floor.
    useSessionFilterStore.getState().toggleStatusFilter(P, 'running', 'page');

    expect(read(selectStatusFilters(P, 'page'))).toEqual(['failed', 'running']);
    expect(read(selectStatusFilters(P, 'sidebar'))).toEqual(['failed']);
  });

  test('an explicit empty on the page is a real answer, not "inherit"', () => {
    useSessionFilterStore.getState().toggleStatusFilter(P, 'failed', 'sidebar');
    useSessionFilterStore.getState().resetFilters(P, 'page');

    expect(read(selectStatusFilters(P, 'page'))).toEqual([]);
    expect(read(selectStatusFilters(P, 'sidebar'))).toEqual(['failed']);
  });
});

describe('the page never writes into the sidebar', () => {
  test('filters, sections and collapse all stay on their own surface', () => {
    const s = useSessionFilterStore.getState();
    s.toggleSourceFilter(P, 'slack', 'page');
    s.toggleSectionHidden(P, 'older', 'page');
    s.collapseAllSections(P, ['today', 'week'], 'page');
    s.setOrderMode(P, 'name', 'page');

    expect(read(selectSourceFilters(P, 'sidebar'))).toEqual([]);
    expect(read(selectHiddenSections(P, 'sidebar'))).toEqual([]);
    expect(read(selectCollapsedSections(P, 'sidebar'))).toEqual([]);
    expect(read(selectOrderMode(P, 'sidebar'))).toBe('activity');

    expect(read(selectSourceFilters(P, 'page'))).toEqual(['slack']);
    expect(read(selectHiddenSections(P, 'page'))).toEqual(['older']);
    expect(read(selectCollapsedSections(P, 'page'))).toEqual(['today', 'week']);
    expect(read(selectOrderMode(P, 'page'))).toBe('name');
  });

  test('two projects never bleed into each other on either surface', () => {
    useSessionFilterStore.getState().setGroupMode(P, 'status', 'page');
    expect(read(selectGroupMode('project-2', 'page'))).toBe('activity');
    expect(read(selectGroupMode('project-2', 'sidebar'))).toBe('activity');
  });
});

describe('snapshot stability (zustand v5 compares with Object.is)', () => {
  test('an unset list selector returns the SAME reference every read', () => {
    // A selector allocating a fresh [] re-renders forever — the bug EMPTY_LIST
    // exists to prevent. Both surfaces must be safe.
    expect(read(selectStatusFilters(P, 'page'))).toBe(read(selectStatusFilters(P, 'page')));
    expect(read(selectHiddenSections(P, 'sidebar'))).toBe(read(selectHiddenSections(P, 'sidebar')));
    // Including the inherit path, which reads through two lookups.
    useSessionFilterStore.getState().toggleSourceFilter(P, 'slack', 'sidebar');
    expect(read(selectSourceFilters(P, 'page'))).toBe(read(selectSourceFilters(P, 'page')));
  });
});
