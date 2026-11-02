import { describe, expect, test } from 'bun:test';

import {
  type BranchRow,
  entryToNode,
  filterBranches,
  historyLabel,
  repoPath,
  repoWebUrl,
  sortBranches,
  toBranchRow,
  toCommitRow,
  treePath,
} from './repo-model.ts';

const branch = (over: Partial<BranchRow>): BranchRow => ({
  name: 'b',
  isDefault: false,
  subject: '',
  atMs: 0,
  sessionTitle: null,
  ...over,
});

describe('repo paths', () => {
  test('tree path and repo path round-trip, the root is empty', () => {
    expect(treePath('src/a.ts')).toBe('/src/a.ts');
    expect(repoPath('/src/a.ts')).toBe('src/a.ts');
    expect(repoPath('/')).toBe('');
  });

  test('a directory entry becomes a node named by its last segment', () => {
    expect(entryToNode({ path: 'src/ui', type: 'directory' })).toEqual({
      name: 'ui',
      path: '/src/ui',
      type: 'directory',
    });
  });
});

describe('rows', () => {
  test('a commit row falls back to a 7-character hash', () => {
    const row = toCommitRow({
      hash: 'abcdef0123456789',
      short_hash: '',
      subject: 'fix',
      author_name: 'Ada',
      committed_at: '2026-10-01T00:00:00Z',
    });
    expect(row.shortHash).toBe('abcdef0');
    expect(row.atMs).toBe(Date.parse('2026-10-01T00:00:00Z'));
  });

  test('a branch row carries the session title', () => {
    const row = toBranchRow({
      name: 's1',
      is_default: false,
      subject: 'x',
      committed_at: '2026-10-01T00:00:00Z',
      session: { title: 'Fix login' },
    });
    expect(row.sessionTitle).toBe('Fix login');
  });
});

describe('branches', () => {
  const rows = [
    branch({ name: 'old', atMs: 1 }),
    branch({ name: 'main', isDefault: true, atMs: 0 }),
    branch({ name: 'new', atMs: 9, sessionTitle: 'Fix login' }),
  ];

  test('the default branch sorts first, then newest first', () => {
    expect(sortBranches(rows).map((row) => row.name)).toEqual(['main', 'new', 'old']);
  });

  test('the filter matches the name or the session title, ignoring case', () => {
    expect(filterBranches(rows, 'MAI').map((row) => row.name)).toEqual(['main']);
    expect(filterBranches(rows, 'login').map((row) => row.name)).toEqual(['new']);
    expect(filterBranches(rows, '  ')).toHaveLength(3);
  });
});

describe('labels', () => {
  test('history names its target', () => {
    expect(historyLabel(null)).toBe('history · repository');
    expect(historyLabel('src/a.ts')).toBe('history · src/a.ts');
  });

  test('the web URL drops a trailing slash', () => {
    expect(repoWebUrl('https://kortix.com/', 'p1')).toBe('https://kortix.com/projects/p1/files');
  });
});
