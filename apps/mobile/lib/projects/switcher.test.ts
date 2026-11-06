import { describe, expect, test } from 'bun:test';

import type { KortixAccount, KortixProject } from '@/lib/projects/projects-client';
import {
  WORKSPACE_PAGE_SEARCH_MIN_ROWS,
  filterWorkspaceRows,
  projectHref,
  isOpenableWorkspaceRow,
  shouldShowWorkspacePageSearch,
  workspaceRows,
  workspaceRowsFromServed,
} from './switcher';

function account(account_id: string, name: string): KortixAccount {
  return { account_id, name } as KortixAccount;
}

function project(project_id: string, name: string, account_id = 'acc-1'): KortixProject {
  return { project_id, name, account_id } as KortixProject;
}

const personal = account('acc-1', 'Personal');
const acme = account('acc-2', 'Acme Inc.');
const empty = account('acc-3', 'Empty');

describe('workspaceRows', () => {
  test('one flat list: every account in server order, each project its own row', () => {
    const lists = new Map([
      ['acc-1', [project('p-1', 'Personal')]],
      // A legacy account with several projects: one row per project.
      ['acc-2', [project('p-2', 'Acme', 'acc-2'), project('p-3', 'Acme Labs', 'acc-2')]],
    ]);
    const rows = workspaceRows([personal, acme], lists);
    expect(rows.map((row) => [row.project.project_id, row.account.account_id])).toEqual([
      ['p-1', 'acc-1'],
      ['p-2', 'acc-2'],
      ['p-3', 'acc-2'],
    ]);
  });

  test('an account with 0 projects is not a workspace and adds no row', () => {
    const lists = new Map([
      ['acc-1', [project('p-1', 'Personal')]],
      ['acc-3', []],
    ]);
    expect(workspaceRows([personal, empty], lists).map((row) => row.project.project_id)).toEqual(['p-1']);
  });

  test('no account, or no loaded list: no row', () => {
    expect(workspaceRows([], new Map())).toEqual([]);
    expect(workspaceRows([personal], new Map())).toEqual([]);
  });
});

describe('shouldShowWorkspacePageSearch', () => {
  test('hidden below 8 rows, shown from 8 (ux.md: "Search appears at 8+ rows")', () => {
    expect(WORKSPACE_PAGE_SEARCH_MIN_ROWS).toBe(8);
    expect(shouldShowWorkspacePageSearch(0)).toBe(false);
    expect(shouldShowWorkspacePageSearch(7)).toBe(false);
    expect(shouldShowWorkspacePageSearch(8)).toBe(true);
  });
});

describe('filterWorkspaceRows', () => {
  const rows = workspaceRows(
    [personal],
    new Map([['acc-1', [project('p-1', 'Marketing site'), project('p-2', 'API gateway'), project('p-3', 'marketing-emails')]]])
  );

  test('empty query returns every row, unfiltered', () => {
    expect(filterWorkspaceRows(rows, '')).toEqual(rows);
    expect(filterWorkspaceRows(rows, '   ')).toEqual(rows);
  });

  test('case-insensitive substring match on the workspace name', () => {
    expect(filterWorkspaceRows(rows, 'MARKETING').map((r) => r.project.project_id)).toEqual(['p-1', 'p-3']);
  });

  test('trims the query before matching', () => {
    expect(filterWorkspaceRows(rows, '  api  ').map((r) => r.project.project_id)).toEqual(['p-2']);
  });

  test('no match returns an empty list', () => {
    expect(filterWorkspaceRows(rows, 'nonexistent')).toEqual([]);
  });
});

describe('projectHref', () => {
  test('builds the typed-router href', () => {
    expect(projectHref('proj-123')).toEqual({ pathname: '/projects/[id]', params: { id: 'proj-123' } });
  });
});

describe('workspaceRowsFromServed — every state from GET /v1/workspaces', () => {
  const owner = { account_id: 'acc-1', name: 'Synthetic Co' } as KortixAccount;
  const project = (id: string, extra: Record<string, unknown> = {}) =>
    ({ project_id: id, account_id: 'acc-1', name: `ws ${id}`, ...extra }) as unknown as KortixProject;

  test('keeps the served state and role, and names the owner account', () => {
    const rows = workspaceRowsFromServed([owner], [
      project('a', { state: 'active', role: 'owner' }),
      project('b', { state: 'deleting', deletion_scheduled_for: '2026-11-20T00:00:00.000Z', role: 'owner' }),
      project('c', { state: 'setup_required', role: 'admin' }),
    ]);
    expect(rows.map((row) => [row.project.project_id, row.state, row.role, row.account.name])).toEqual([
      ['a', 'active', 'owner', 'Synthetic Co'],
      ['b', 'deleting', 'owner', 'Synthetic Co'],
      ['c', 'setup_required', 'admin', 'Synthetic Co'],
    ]);
    expect(rows[1]!.deletionScheduledFor).toBe('2026-11-20T00:00:00.000Z');
  });

  test('only an active row opens; an older API without state reads as active', () => {
    const rows = workspaceRowsFromServed([owner], [project('a'), project('b', { state: 'deleting' })]);
    expect(rows.map(isOpenableWorkspaceRow)).toEqual([true, false]);
  });
});
