import { describe, expect, test } from 'bun:test';

import { MAX_DIFF_ROWS, parsePatch, parsePatchFile } from './parse-patch';

function patchOf(files: number, linesPerFile: number): string {
  let out = '';
  for (let f = 0; f < files; f++) {
    out += `diff --git a/f${f}.ts b/f${f}.ts\nindex 1..2 100644\n--- a/f${f}.ts\n+++ b/f${f}.ts\n@@ -1,0 +1,${linesPerFile} @@\n`;
    for (let i = 0; i < linesPerFile; i++) out += `+line ${i}\n`;
  }
  return out;
}

describe('parsePatch', () => {
  test('parses files, hunks and line numbers', () => {
    const { byPath, truncated } = parsePatch(patchOf(2, 3));
    expect([...byPath.keys()]).toEqual(['f0.ts', 'f1.ts']);
    expect(byPath.get('f0.ts')!.rows).toEqual([
      { kind: 'hunk', num: null, text: '@@ -1,0 +1,3 @@' },
      { kind: 'add', num: 1, text: 'line 0' },
      { kind: 'add', num: 2, text: 'line 1' },
      { kind: 'add', num: 3, text: 'line 2' },
    ]);
    expect(truncated).toBe(false);
  });

  test('caps rows across the whole patch at maxRows and says so', () => {
    const { byPath, truncated } = parsePatch(patchOf(5, 100), 150);
    const total = [...byPath.values()].reduce((n, file) => n + file.rows.length, 0);
    expect(total).toBe(150);
    expect(byPath.size).toBe(2);
    expect(truncated).toBe(true);
  });

  test('the default cap is MAX_DIFF_ROWS', () => {
    const { byPath, truncated } = parsePatch(patchOf(3, 1000));
    const total = [...byPath.values()].reduce((n, file) => n + file.rows.length, 0);
    expect(total).toBe(MAX_DIFF_ROWS);
    expect(truncated).toBe(true);
  });
});

describe('parsePatchFile', () => {
  test('parses only the named file, with no row cap', () => {
    const patch = patchOf(3, 2500);
    const rows = parsePatchFile(patch, 'f1.ts');
    expect(rows?.binary).toBe(false);
    expect(rows?.rows.length).toBe(2501);
    expect(rows?.rows[1]).toEqual({ kind: 'add', num: 1, text: 'line 0' });
  });

  test('a path the patch does not touch → null', () => {
    expect(parsePatchFile(patchOf(1, 3), 'missing.ts')).toBeNull();
  });

  test('a binary file says so', () => {
    const patch = 'diff --git a/logo.png b/logo.png\nindex 1..2 100644\nBinary files a/logo.png and b/logo.png differ\n';
    expect(parsePatchFile(patch, 'logo.png')).toEqual({ binary: true, rows: [] });
  });
});
