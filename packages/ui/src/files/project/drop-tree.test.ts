import { describe, expect, test } from 'bun:test';

import { hasFolder, readDroppedTree, treeLevels } from './drop-tree';

const file = (name: string) => ({
  isFile: true,
  isDirectory: false,
  name,
  file: (ok: (f: File) => void) => ok(new File(['x'], name)),
});
/** A folder whose reader answers in pages of `size`, then an empty page. */
const folder = (name: string, children: object[], size = 2) => ({
  isFile: false,
  isDirectory: true,
  name,
  createReader: () => {
    let at = 0;
    return {
      readEntries: (ok: (e: object[]) => void) => {
        ok(children.slice(at, at + size) as never);
        at += size;
      },
    };
  },
});

describe('dropped folders', () => {
  test('every file comes back with its folder, across reader pages', async () => {
    const tree = folder('eng', [file('a.md'), folder('docs', [file('b.md'), file('c.md'), file('d.md')]), file('e.md')]);
    const items = await readDroppedTree([tree as never, file('loose.txt') as never]);
    expect(items.map((i) => `${i.dir}|${i.file.name}`)).toEqual([
      'eng|a.md',
      'eng/docs|b.md',
      'eng/docs|c.md',
      'eng/docs|d.md',
      'eng|e.md',
      '|loose.txt',
    ]);
  });

  test('folders are created parents first, each once', () => {
    const f = new File([], 'x');
    expect(
      treeLevels([
        { file: f, dir: 'eng/docs/api' },
        { file: f, dir: 'eng/docs' },
        { file: f, dir: 'eng' },
        { file: f, dir: '' },
      ]),
    ).toEqual([['eng'], ['eng/docs'], ['eng/docs/api']]);
  });

  test('a drop of plain files has no folder', () => {
    expect(hasFolder([file('a') as never])).toBe(false);
    expect(hasFolder([folder('x', []) as never])).toBe(true);
  });
});
