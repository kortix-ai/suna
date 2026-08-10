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
  EMPTY_LIST,
  selectCollapsedSections,
  selectGroupMode,
  selectHiddenSections,
  selectOrderMode,
  selectSourceFilters,
  selectStatusFilters,
  useSessionFilterStore,
} from './session-filter-store';

const WORKSPACE = 'workspace-1';
const read = <T>(selector: (s: ReturnType<typeof useSessionFilterStore.getState>) => T): T =>
  selector(useSessionFilterStore.getState());

beforeEach(() => {
  useSessionFilterStore.setState({
    groupByWorkspace: {},
    orderByWorkspace: {},
    statusFiltersByWorkspace: {},
    sourceFiltersByWorkspace: {},
    hiddenSectionsByWorkspace: {},
    collapsedSectionsByWorkspace: {},
  });
});

describe('defaults', () => {
  test('both surfaces start on the same defaults', () => {
    expect(read(selectGroupMode(WORKSPACE, 'sidebar'))).toBe('activity');
    expect(read(selectGroupMode(WORKSPACE, 'page'))).toBe('activity');
    expect(read(selectOrderMode(WORKSPACE, 'page'))).toBe('activity');
    expect(read(selectStatusFilters(WORKSPACE, 'page'))).toEqual([]);
  });

  test('the surface argument defaults to the sidebar', () => {
    useSessionFilterStore.getState().setGroupMode(WORKSPACE, 'source');
    expect(read(selectGroupMode(WORKSPACE))).toBe('source');
    expect(read(selectGroupMode(WORKSPACE, 'sidebar'))).toBe('source');
  });
});

describe('the page inherits the sidebar until it chooses for itself', () => {
  test('a sidebar grouping shows through on the page', () => {
    useSessionFilterStore.getState().setGroupMode(WORKSPACE, 'source', 'sidebar');
    expect(read(selectGroupMode(WORKSPACE, 'page'))).toBe('source');
  });

  test('a sidebar filter shows through on the page', () => {
    useSessionFilterStore.getState().toggleStatusFilter(WORKSPACE, 'failed', 'sidebar');
    expect(read(selectStatusFilters(WORKSPACE, 'page'))).toEqual(['failed']);
  });

  test('collapsed sections are the ONE thing the page does not inherit', () => {
    // Folding "Older" away in the narrow sidebar must not open the full
    // sessions page with its sections already shut. Every section starts
    // expanded there.
    useSessionFilterStore.getState().toggleSectionCollapsed(WORKSPACE, 'older', 'sidebar');

    expect(read(selectCollapsedSections(WORKSPACE, 'sidebar'))).toEqual(['older']);
    expect(read(selectCollapsedSections(WORKSPACE, 'page'))).toEqual([]);
  });

  test('a page collapse starts from the page list, not the sidebar list', () => {
    useSessionFilterStore.getState().toggleSectionCollapsed(WORKSPACE, 'older', 'sidebar');
    // Collapsing the same section on the page must ADD it there, not toggle the
    // inherited entry back off and leave the page unchanged.
    useSessionFilterStore.getState().toggleSectionCollapsed(WORKSPACE, 'older', 'page');

    expect(read(selectCollapsedSections(WORKSPACE, 'page'))).toEqual(['older']);
    expect(read(selectCollapsedSections(WORKSPACE, 'sidebar'))).toEqual(['older']);
  });

  test('once the page chooses, it stops following the sidebar', () => {
    useSessionFilterStore.getState().setGroupMode(WORKSPACE, 'source', 'sidebar');
    useSessionFilterStore.getState().setGroupMode(WORKSPACE, 'status', 'page');

    expect(read(selectGroupMode(WORKSPACE, 'page'))).toBe('status');
    expect(read(selectGroupMode(WORKSPACE, 'sidebar'))).toBe('source');

    // A later sidebar change must not reach back into the page.
    useSessionFilterStore.getState().setGroupMode(WORKSPACE, 'none', 'sidebar');
    expect(read(selectGroupMode(WORKSPACE, 'page'))).toBe('status');
  });

  test('a page toggle starts from the INHERITED value, not from empty', () => {
    useSessionFilterStore.getState().toggleStatusFilter(WORKSPACE, 'failed', 'sidebar');
    // The page is showing ['failed']; adding 'running' there must yield both,
    // not drop the inherited one on the floor.
    useSessionFilterStore.getState().toggleStatusFilter(WORKSPACE, 'running', 'page');

    expect(read(selectStatusFilters(WORKSPACE, 'page'))).toEqual(['failed', 'running']);
    expect(read(selectStatusFilters(WORKSPACE, 'sidebar'))).toEqual(['failed']);
  });

  test('an explicit empty on the page is a real answer, not "inherit"', () => {
    useSessionFilterStore.getState().toggleStatusFilter(WORKSPACE, 'failed', 'sidebar');
    useSessionFilterStore.getState().resetFilters(WORKSPACE, 'page');

    expect(read(selectStatusFilters(WORKSPACE, 'page'))).toEqual([]);
    expect(read(selectStatusFilters(WORKSPACE, 'sidebar'))).toEqual(['failed']);
  });
});

describe('the page never writes into the sidebar', () => {
  test('filters, sections and collapse all stay on their own surface', () => {
    const s = useSessionFilterStore.getState();
    s.toggleSourceFilter(WORKSPACE, 'slack', 'page');
    s.toggleSectionHidden(WORKSPACE, 'older', 'page');
    s.collapseAllSections(WORKSPACE, ['today', 'week'], 'page');
    s.setOrderMode(WORKSPACE, 'name', 'page');

    expect(read(selectSourceFilters(WORKSPACE, 'sidebar'))).toEqual([]);
    expect(read(selectHiddenSections(WORKSPACE, 'sidebar'))).toEqual([]);
    expect(read(selectCollapsedSections(WORKSPACE, 'sidebar'))).toEqual([]);
    expect(read(selectOrderMode(WORKSPACE, 'sidebar'))).toBe('activity');

    expect(read(selectSourceFilters(WORKSPACE, 'page'))).toEqual(['slack']);
    expect(read(selectHiddenSections(WORKSPACE, 'page'))).toEqual(['older']);
    expect(read(selectCollapsedSections(WORKSPACE, 'page'))).toEqual(['today', 'week']);
    expect(read(selectOrderMode(WORKSPACE, 'page'))).toBe('name');
  });

  test('two workspaces never bleed into each other on either surface', () => {
    useSessionFilterStore.getState().setGroupMode(WORKSPACE, 'status', 'page');
    expect(read(selectGroupMode('workspace-2', 'page'))).toBe('activity');
    expect(read(selectGroupMode('workspace-2', 'sidebar'))).toBe('activity');
  });
});

describe('snapshot stability (zustand v5 compares with Object.is)', () => {
  test('an unset list selector returns the SAME reference every read', () => {
    // A selector allocating a fresh [] re-renders forever — the bug EMPTY_LIST
    // exists to prevent. Both surfaces must be safe.
    expect(read(selectStatusFilters(WORKSPACE, 'page'))).toBe(
      read(selectStatusFilters(WORKSPACE, 'page')),
    );
    expect(read(selectHiddenSections(WORKSPACE, 'sidebar'))).toBe(
      read(selectHiddenSections(WORKSPACE, 'sidebar')),
    );
    // Including the inherit path, which reads through two lookups.
    useSessionFilterStore.getState().toggleSourceFilter(WORKSPACE, 'slack', 'sidebar');
    expect(read(selectSourceFilters(WORKSPACE, 'page'))).toBe(
      read(selectSourceFilters(WORKSPACE, 'page')),
    );
  });
});

describe('Workspace persistence compatibility', () => {
  test('uses the canonical Workspace storage key', () => {
    expect(useSessionFilterStore.persist.getOptions().name).toBe('kortix.workspace-session-view');
  });

  test('migrates legacy Project map names without losing values', async () => {
    const migrate = useSessionFilterStore.persist.getOptions().migrate;
    expect(migrate).toBeDefined();

    const migrated = (await migrate?.(
      {
        groupByProject: { [WORKSPACE]: 'source' },
        orderByProject: { [WORKSPACE]: 'name' },
        statusFiltersByProject: { [WORKSPACE]: ['failed'] },
        sourceFiltersByProject: { [WORKSPACE]: ['slack'] },
        hiddenSectionsByProject: { [WORKSPACE]: ['older'] },
        collapsedSectionsByProject: { [WORKSPACE]: ['today'] },
      },
      0,
    )) as ReturnType<typeof useSessionFilterStore.getState>;

    expect(migrated.groupByWorkspace[WORKSPACE]).toBe('source');
    expect(migrated.orderByWorkspace[WORKSPACE]).toBe('name');
    expect(migrated.statusFiltersByWorkspace[WORKSPACE]).toEqual(['failed']);
    expect(migrated.sourceFiltersByWorkspace[WORKSPACE]).toEqual(['slack']);
    expect(migrated.hiddenSectionsByWorkspace[WORKSPACE]).toEqual(['older']);
    expect(migrated.collapsedSectionsByWorkspace[WORKSPACE]).toEqual(['today']);
  });

  test('exports one frozen fallback for absent list state', () => {
    expect(Object.isFrozen(EMPTY_LIST)).toBe(true);
    expect(EMPTY_LIST).toEqual([]);
  });
});
