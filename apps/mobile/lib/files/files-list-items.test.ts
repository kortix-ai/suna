import { describe, expect, test } from 'bun:test';

import { buildFilesListItems, type FilesListEntry } from './files-list-items';

const dir = (path: string): FilesListEntry => ({ path, type: 'directory' });
const file = (path: string): FilesListEntry => ({ path, type: 'file' });

describe('buildFilesListItems', () => {
  test('list mode: titles only when both sections show; rows carry index and count', () => {
    const items = buildFilesListItems([dir('a'), dir('b')], [file('x.ts')], 'list');
    expect(items.map((i) => i.key)).toEqual(['title:folders', 'folders:a', 'folders:b', 'title:files', 'files:x.ts']);
    const rows = items.filter((i) => i.kind === 'row');
    expect(rows.map((r) => (r.kind === 'row' ? [r.index, r.count] : null))).toEqual([
      [0, 2],
      [1, 2],
      [0, 1],
    ]);
  });

  test('list mode with one section has no title', () => {
    const items = buildFilesListItems([], [file('x.ts'), file('y.ts')], 'list');
    expect(items.map((i) => i.kind)).toEqual(['row', 'row']);
    expect(items.every((i) => !i.first)).toBe(true);
  });

  test('grid mode: always titled, tiles in lines of two', () => {
    const items = buildFilesListItems([dir('a'), dir('b'), dir('c')], [file('x.ts')], 'grid');
    expect(items.map((i) => i.kind)).toEqual(['title', 'tiles', 'tiles', 'title', 'tiles']);
    const lines = items.filter((i) => i.kind === 'tiles').map((i) => (i.kind === 'tiles' ? i.entries.map((e) => e.path) : []));
    expect(lines).toEqual([['a', 'b'], ['c'], ['x.ts']]);
  });

  test('the second section is marked for the section gap', () => {
    const grid = buildFilesListItems([dir('a')], [file('x.ts')], 'grid');
    expect(grid.map((i) => i.first)).toEqual([false, false, true, false]);
    const list = buildFilesListItems([dir('a')], [file('x.ts')], 'list');
    expect(list.map((i) => i.first)).toEqual([false, false, true, false]);
  });

  test('nothing in, nothing out; keys are unique', () => {
    expect(buildFilesListItems([], [], 'grid')).toEqual([]);
    const items = buildFilesListItems([dir('a'), dir('b')], [file('a'), file('b')], 'grid');
    expect(new Set(items.map((i) => i.key)).size).toBe(items.length);
  });
});
