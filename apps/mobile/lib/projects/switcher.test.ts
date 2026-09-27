import { describe, expect, test } from 'bun:test';

import type { KortixAccount, KortixProject } from '@/lib/projects/projects-client';
import {
  SWITCHER_SEARCH_THRESHOLD,
  filterProjectsByQuery,
  projectHref,
  shouldShowProjectSearch,
  switcherChips,
} from './switcher';

function account(account_id: string, name: string): KortixAccount {
  return { account_id, name } as KortixAccount;
}

function project(project_id: string, name: string): KortixProject {
  return { project_id, name } as KortixProject;
}

const personal = account('acc-1', 'Personal');
const acme = account('acc-2', 'Acme Inc.');

describe('switcherChips', () => {
  test('keeps the accounts in the given order, then appends New account', () => {
    const chips = switcherChips([personal, acme]);
    expect(chips).toEqual([
      { kind: 'account', account: personal },
      { kind: 'account', account: acme },
      { kind: 'new-account' },
    ]);
  });

  test('no accounts: just the New account chip', () => {
    expect(switcherChips([])).toEqual([{ kind: 'new-account' }]);
  });
});

describe('shouldShowProjectSearch', () => {
  test('hidden at or below the threshold', () => {
    expect(shouldShowProjectSearch(0)).toBe(false);
    expect(shouldShowProjectSearch(SWITCHER_SEARCH_THRESHOLD)).toBe(false);
  });

  test('shown once the list is longer than the threshold', () => {
    expect(shouldShowProjectSearch(SWITCHER_SEARCH_THRESHOLD + 1)).toBe(true);
  });
});

describe('filterProjectsByQuery', () => {
  const projects = [project('p-1', 'Marketing site'), project('p-2', 'API gateway'), project('p-3', 'marketing-emails')];

  test('empty query returns every project, unfiltered', () => {
    expect(filterProjectsByQuery(projects, '')).toEqual(projects);
    expect(filterProjectsByQuery(projects, '   ')).toEqual(projects);
  });

  test('case-insensitive substring match on the name', () => {
    expect(filterProjectsByQuery(projects, 'MARKETING').map((p) => p.project_id)).toEqual(['p-1', 'p-3']);
  });

  test('trims the query before matching', () => {
    expect(filterProjectsByQuery(projects, '  api  ').map((p) => p.project_id)).toEqual(['p-2']);
  });

  test('no match returns an empty list', () => {
    expect(filterProjectsByQuery(projects, 'nonexistent')).toEqual([]);
  });
});

describe('projectHref', () => {
  test('builds the typed-router href', () => {
    expect(projectHref('proj-123')).toEqual({ pathname: '/projects/[id]', params: { id: 'proj-123' } });
  });
});
