import { describe, expect, test } from 'bun:test';

import { searchFileTree, searchResultLocation } from './tree-search';

const TREE = [
  { path: 'README.md', size: 10 },
  { path: 'src/app/page.tsx', size: 200 },
  { path: 'src/app/layout.tsx', size: 120 },
  { path: 'src/lib/app-config.ts', size: 50 },
  { path: 'docs/guide/setup.md', size: 30 },
  { path: 'apps/web/index.ts', size: 5 },
];

describe('searchFileTree', () => {
  test('an empty or blank query returns nothing', () => {
    expect(searchFileTree(TREE, '')).toEqual([]);
    expect(searchFileTree(TREE, '   ')).toEqual([]);
  });

  test('finds files in nested folders, not only the root', () => {
    const results = searchFileTree(TREE, 'setup');
    expect(results).toEqual([
      { name: 'setup.md', path: 'docs/guide/setup.md', parent: 'docs/guide', type: 'file', size: 30 },
    ]);
  });

  test('derives folders from file paths and lists them before files', () => {
    const results = searchFileTree(TREE, 'app');
    const types = results.map((r) => r.type);
    expect(types.indexOf('file')).toBeGreaterThan(types.lastIndexOf('directory'));
    const dirs = results.filter((r) => r.type === 'directory').map((r) => r.path);
    // `apps` and `src/app` start with the query; `apps/web` matches by path only.
    expect(dirs).toEqual(['apps', 'src/app', 'apps/web']);
  });

  test('ranks name-prefix, then name-contains, then path-only matches', () => {
    const files = searchFileTree(TREE, 'app').filter((r) => r.type === 'file').map((r) => r.path);
    expect(files).toEqual(['src/lib/app-config.ts', 'apps/web/index.ts', 'src/app/layout.tsx', 'src/app/page.tsx']);
  });

  test('is case-insensitive and matches a typed path', () => {
    expect(searchFileTree(TREE, 'readme').map((r) => r.path)).toEqual(['README.md']);
    expect(searchFileTree(TREE, 'src/app/').map((r) => r.path)).toEqual(['src/app/layout.tsx', 'src/app/page.tsx']);
  });

  test('lists each folder once however many files it holds', () => {
    const dirs = searchFileTree(TREE, 'src').filter((r) => r.type === 'directory');
    expect(dirs.map((d) => d.path)).toEqual(['src', 'src/app', 'src/lib']);
  });

  test('tolerates a leading slash and a null size', () => {
    expect(searchFileTree([{ path: '/a/b.txt', size: null }], 'b.txt')).toEqual([
      { name: 'b.txt', path: 'a/b.txt', parent: 'a', type: 'file', size: undefined },
    ]);
  });
});

describe('searchResultLocation', () => {
  test('names the parent folder, or the root label', () => {
    expect(searchResultLocation({ parent: 'src/app' })).toBe('src/app');
    expect(searchResultLocation({ parent: '' })).toBe('Files');
  });
});
