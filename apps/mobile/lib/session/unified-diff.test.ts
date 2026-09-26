import { describe, expect, test } from 'bun:test';

import { buildUnifiedDiff, parseUnifiedPatch, splitDiffLines } from './unified-diff';

const lines = (n: number, prefix = 'l') => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`).join('\n');

describe('splitDiffLines', () => {
  test('a trailing newline does not add an empty line; CRLF splits too', () => {
    expect(splitDiffLines('a\nb\n')).toEqual(['a', 'b']);
    expect(splitDiffLines('a\r\nb')).toEqual(['a', 'b']);
    expect(splitDiffLines('')).toEqual([]);
  });
  test('a literal backslash-n inside code stays one line', () => {
    expect(splitDiffLines("const nl = '\\n';")).toEqual(["const nl = '\\n';"]);
  });
});

describe('buildUnifiedDiff', () => {
  test('one changed line: del then add, surrounded by context, with line numbers', () => {
    const diff = buildUnifiedDiff('a\nb\nc', 'a\nB\nc');
    expect(diff.additions).toBe(1);
    expect(diff.deletions).toBe(1);
    expect(diff.rows).toEqual([
      { kind: 'line', type: 'context', oldLine: 1, newLine: 1, text: 'a' },
      { kind: 'line', type: 'del', oldLine: 2, text: 'b' },
      { kind: 'line', type: 'add', newLine: 2, text: 'B' },
      { kind: 'line', type: 'context', oldLine: 3, newLine: 3, text: 'c' },
    ]);
  });

  test('context is capped at 3 lines and the gaps become separators', () => {
    const before = lines(20);
    const after = before.replace('l2\n', 'X\n').replace('l18\n', 'Y\n');
    const diff = buildUnifiedDiff(before, after);
    const summary = diff.rows.map((r) => (r.kind === 'separator' ? `…${r.hiddenLines}` : `${r.type[0]}:${r.text}`));
    expect(summary).toEqual([
      'c:l1', 'd:l2', 'a:X', 'c:l3', 'c:l4', 'c:l5',
      '…9',
      'c:l15', 'c:l16', 'c:l17', 'd:l18', 'a:Y', 'c:l19', 'c:l20',
    ]);
  });

  test('leading unchanged lines past the context become a leading separator', () => {
    const diff = buildUnifiedDiff(lines(10), lines(10).replace('l10', 'Z'));
    expect(diff.rows[0]).toEqual({ kind: 'separator', hiddenLines: 6 });
  });

  test('a new file is all additions', () => {
    const diff = buildUnifiedDiff('', 'a\nb');
    expect(diff.rows.map((r) => (r.kind === 'line' ? r.type : 'sep'))).toEqual(['add', 'add']);
    expect(diff.additions).toBe(2);
  });

  test('identical text has no rows', () => {
    expect(buildUnifiedDiff('a\nb', 'a\nb').rows).toEqual([]);
  });
});

describe('parseUnifiedPatch', () => {
  test('reads hunks, numbers lines, and counts changes; headers are skipped', () => {
    const patch = [
      'diff --git a/x.ts b/x.ts',
      'index 1..2 100644',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -1,3 +1,3 @@',
      ' a',
      '-b',
      '+B',
      ' c',
      '@@ -10,2 +10,3 @@ function f() {',
      ' j',
      '+k',
      ' l',
      '\\ No newline at end of file',
    ].join('\n');
    const diff = parseUnifiedPatch(patch);
    expect(diff.additions).toBe(2);
    expect(diff.deletions).toBe(1);
    expect(diff.rows).toEqual([
      { kind: 'line', type: 'context', oldLine: 1, newLine: 1, text: 'a' },
      { kind: 'line', type: 'del', oldLine: 2, text: 'b' },
      { kind: 'line', type: 'add', newLine: 2, text: 'B' },
      { kind: 'line', type: 'context', oldLine: 3, newLine: 3, text: 'c' },
      { kind: 'separator', hiddenLines: 6 },
      { kind: 'line', type: 'context', oldLine: 10, newLine: 10, text: 'j' },
      { kind: 'line', type: 'add', newLine: 11, text: 'k' },
      { kind: 'line', type: 'context', oldLine: 11, newLine: 12, text: 'l' },
    ]);
  });

  test('text with no hunk header yields no rows', () => {
    expect(parseUnifiedPatch('just text').rows).toEqual([]);
  });
});
