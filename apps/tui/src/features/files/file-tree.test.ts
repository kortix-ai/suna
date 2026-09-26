import { describe, expect, test } from 'bun:test';

import {
  type TreeNode,
  collapse,
  compareNodes,
  createTree,
  expand,
  filterRows,
  flatten,
  forgetLoads,
  hideDotfiles,
  loadStateOf,
  markLoading,
  parentOf,
  setChildren,
  setError,
  sortNodes,
} from './file-tree.ts';

const ROOT = '/workspace';

function node(path: string, type: 'file' | 'directory', ignored = false): TreeNode {
  return { name: path.slice(path.lastIndexOf('/') + 1), path, type, ignored };
}

const ROOT_NODES: TreeNode[] = [
  node('/workspace/README.md', 'file'),
  node('/workspace/src', 'directory'),
  node('/workspace/node_modules', 'directory', true),
  node('/workspace/.env', 'file'),
];

const SRC_NODES: TreeNode[] = [
  node('/workspace/src/index.ts', 'file'),
  node('/workspace/src/lib', 'directory'),
];

describe('sorting', () => {
  test('directories come before files, then case-insensitive name', () => {
    const sorted = sortNodes(ROOT_NODES).map((entry) => entry.name);
    expect(sorted).toEqual(['node_modules', 'src', '.env', 'README.md']);
  });

  test('compareNodes breaks a case-insensitive tie instead of returning 0', () => {
    const upperFirst = compareNodes(node('/a/X', 'file'), node('/a/x', 'file'));
    expect(upperFirst).not.toBe(0);
    // Antisymmetric, so `Array.prototype.sort` is stable across re-lists.
    expect(compareNodes(node('/a/x', 'file'), node('/a/X', 'file'))).toBe(-upperFirst);
    expect(compareNodes(node('/a/x', 'file'), node('/a/x', 'file'))).toBe(0);
  });
});

describe('load states', () => {
  test('a fresh tree has no loads and only the root expanded', () => {
    const tree = createTree(ROOT);
    expect(loadStateOf(tree, ROOT)).toBeUndefined();
    expect(flatten(tree)).toEqual([]);
    expect(tree.expanded.has(ROOT)).toBe(true);
  });

  test('loading, loaded and error are distinct and replace each other', () => {
    let tree = markLoading(createTree(ROOT), ROOT);
    expect(loadStateOf(tree, ROOT)).toEqual({ state: 'loading' });
    tree = setChildren(tree, ROOT, ROOT_NODES);
    expect(loadStateOf(tree, ROOT)?.state).toBe('loaded');
    tree = setError(tree, ROOT, 'daemon unreachable');
    expect(loadStateOf(tree, ROOT)).toEqual({ state: 'error', message: 'daemon unreachable' });
  });

  test('forgetLoads drops children but keeps which directories are open', () => {
    let tree = setChildren(createTree(ROOT), ROOT, ROOT_NODES);
    tree = expand(tree, '/workspace/src');
    tree = setChildren(tree, '/workspace/src', SRC_NODES);
    const refreshed = forgetLoads(tree);
    expect(refreshed.loads.size).toBe(0);
    expect(refreshed.expanded.has('/workspace/src')).toBe(true);
  });
});

describe('flatten', () => {
  test('emits the root children in sorted order at depth 0', () => {
    const tree = setChildren(createTree(ROOT), ROOT, ROOT_NODES);
    expect(flatten(tree).map((row) => [row.name, row.depth])).toEqual([
      ['node_modules', 0],
      ['src', 0],
      ['.env', 0],
      ['README.md', 0],
    ]);
  });

  test('an expanded directory inlines its children at depth + 1', () => {
    let tree = setChildren(createTree(ROOT), ROOT, ROOT_NODES);
    tree = expand(tree, '/workspace/src');
    tree = setChildren(tree, '/workspace/src', SRC_NODES);
    expect(flatten(tree).map((row) => `${'  '.repeat(row.depth)}${row.name}`)).toEqual([
      'node_modules',
      'src',
      '  lib',
      '  index.ts',
      '.env',
      'README.md',
    ]);
  });

  test('collapse removes the children again without forgetting them', () => {
    let tree = setChildren(createTree(ROOT), ROOT, ROOT_NODES);
    tree = setChildren(expand(tree, '/workspace/src'), '/workspace/src', SRC_NODES);
    tree = collapse(tree, '/workspace/src');
    expect(flatten(tree).map((row) => row.name)).toEqual([
      'node_modules',
      'src',
      '.env',
      'README.md',
    ]);
    expect(loadStateOf(tree, '/workspace/src')?.state).toBe('loaded');
  });

  test('a directory being loaded reports loading on its own row', () => {
    let tree = setChildren(createTree(ROOT), ROOT, ROOT_NODES);
    tree = markLoading(expand(tree, '/workspace/src'), '/workspace/src');
    const row = flatten(tree).find((entry) => entry.name === 'src');
    expect(row?.loading).toBe(true);
    expect(row?.expanded).toBe(true);
  });

  test('a failed directory carries its message on the row', () => {
    let tree = setChildren(createTree(ROOT), ROOT, ROOT_NODES);
    tree = setError(expand(tree, '/workspace/src'), '/workspace/src', 'EACCES');
    expect(flatten(tree).find((entry) => entry.name === 'src')?.error).toBe('EACCES');
  });

  test('the ignored flag survives into the row', () => {
    const tree = setChildren(createTree(ROOT), ROOT, ROOT_NODES);
    expect(flatten(tree).find((entry) => entry.name === 'node_modules')?.ignored).toBe(true);
    expect(flatten(tree).find((entry) => entry.name === 'src')?.ignored).toBe(false);
  });
});

describe('filterRows', () => {
  function deepTree() {
    let tree = setChildren(createTree(ROOT), ROOT, ROOT_NODES);
    tree = setChildren(expand(tree, '/workspace/src'), '/workspace/src', SRC_NODES);
    tree = setChildren(expand(tree, '/workspace/src/lib'), '/workspace/src/lib', [
      node('/workspace/src/lib/clock.ts', 'file'),
    ]);
    return tree;
  }

  test('an empty query is the identity', () => {
    const rows = flatten(deepTree());
    expect(filterRows(rows, '   ')).toEqual(rows);
  });

  test('matches by name, case-insensitively', () => {
    const rows = filterRows(flatten(deepTree()), 'readme');
    expect(rows.map((row) => row.name)).toEqual(['README.md']);
  });

  test('keeps the ancestor directories of a match so the hit reads in place', () => {
    const rows = filterRows(flatten(deepTree()), 'clock');
    expect(rows.map((row) => row.name)).toEqual(['src', 'lib', 'clock.ts']);
  });

  test('a query nothing matches yields no rows', () => {
    expect(filterRows(flatten(deepTree()), 'zzz')).toEqual([]);
  });
});

describe('parentOf', () => {
  test('is null at the root and the directory above otherwise', () => {
    const tree = createTree(ROOT);
    expect(parentOf(tree, ROOT)).toBeNull();
    expect(parentOf(tree, '/workspace/src/lib')).toBe('/workspace/src');
    expect(parentOf(tree, '/workspace/src')).toBe(ROOT);
  });
});

describe('hideDotfiles', () => {
  function treeWithDots() {
    let tree = setChildren(createTree(ROOT), ROOT, [
      node('/workspace/.git', 'directory'),
      node('/workspace/.kortix', 'directory'),
      node('/workspace/.gitignore', 'file'),
      node('/workspace/README.md', 'file'),
    ]);
    tree = setChildren(expand(tree, '/workspace/.git'), '/workspace/.git', [
      node('/workspace/.git/HEAD', 'file'),
    ]);
    tree = setChildren(expand(tree, '/workspace/.kortix'), '/workspace/.kortix', [
      node('/workspace/.kortix/agents', 'directory'),
    ]);
    return tree;
  }

  test('drops dot entries and everything beneath a dropped directory', () => {
    const rows = hideDotfiles(flatten(treeWithDots()));
    expect(rows.map((row) => row.name)).toEqual(['.kortix', 'agents', 'README.md']);
  });

  test('.kortix and .opencode are always visible', () => {
    const rows = hideDotfiles(flatten(treeWithDots()));
    expect(rows.some((row) => row.name === '.kortix')).toBe(true);
    expect(rows.some((row) => row.name === '.git')).toBe(false);
    expect(rows.some((row) => row.name === 'HEAD')).toBe(false);
  });

  test('a tree with no dot entries is unchanged', () => {
    const tree = setChildren(createTree(ROOT), ROOT, [node('/workspace/src', 'directory')]);
    const rows = flatten(tree);
    expect(hideDotfiles(rows)).toEqual(rows);
  });
});
