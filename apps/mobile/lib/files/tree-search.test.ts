import { describe, expect, test } from 'bun:test';

import { directoryChildren, isCutDirectory, searchFileTree, searchResultLocation } from './tree-search';

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

// KRTX-1723: the page read one recursive list cut at 1,000 files, so every
// folder that sorted after file 1,000 was missing. It reads one level now.
describe('directoryChildren', () => {
  test('splits one folder level into folder names and files, in entry order', () => {
    expect(
      directoryChildren([
        {
          entries: [
            { path: 'src/z', type: 'directory' },
            { path: 'src/index.ts', type: 'file', size: 12 },
            { path: 'src/a', type: 'directory' },
          ],
        },
      ]),
    ).toEqual({ dirs: ['z', 'a'], files: [{ path: 'src/index.ts', size: 12 }] });
  });

  test('a file without a size keeps a null size', () => {
    expect(directoryChildren([{ entries: [{ path: 'a.txt', type: 'file' }] }]).files).toEqual([
      { path: 'a.txt', size: null },
    ]);
  });

  test('a folder over one page joins its pages in order, each entry once', () => {
    const page = (from: number, to: number) => ({
      entries: Array.from({ length: to - from }, (_, i) => ({
        path: `a/f${String(from + i).padStart(4, '0')}.txt`,
        type: 'file' as const,
      })),
    });
    const { files } = directoryChildren([page(0, 500), page(500, 1000), page(1000, 1200)]);
    expect(files).toHaveLength(1200);
    expect(new Set(files.map((f) => f.path)).size).toBe(1200);
    expect(files[0].path).toBe('a/f0000.txt');
    expect(files[500].path).toBe('a/f0500.txt');
    expect(files[1199].path).toBe('a/f1199.txt');
  });

  test('no pages yet is an empty folder level', () => {
    expect(directoryChildren([])).toEqual({ dirs: [], files: [] });
  });
});

// KRTX-1723: an API older than paging ignores `limit`, cuts the folder at
// 5,000 entries and sends no cursor. The page must not read as complete.
describe('isCutDirectory', () => {
  test('a cut last page without a cursor is cut', () => {
    expect(isCutDirectory([{ truncated: true }])).toBe(true);
    expect(isCutDirectory([{ truncated: true, next_cursor: null }])).toBe(true);
  });

  test('a page with a cursor, a whole page, or no page yet is not', () => {
    expect(isCutDirectory([{ truncated: true, next_cursor: 'C2' }])).toBe(false);
    expect(isCutDirectory([{ truncated: false, next_cursor: null }])).toBe(false);
    expect(isCutDirectory([])).toBe(false);
  });
});
