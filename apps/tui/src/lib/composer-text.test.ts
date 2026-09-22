import { describe, expect, test } from 'bun:test';

import {
  COMPOSER_MAX_ROWS,
  composerRows,
  insertNewline,
  isSlashTrigger,
  parseMentions,
  splitCommandInput,
  visualRowCount,
  wrappedRowCount,
} from './composer-text.ts';

describe('wrappedRowCount', () => {
  test('a line that fits is one row', () => {
    expect(wrappedRowCount('hello', 20)).toBe(1);
    expect(wrappedRowCount('', 20)).toBe(1);
  });

  test('breaks before the word that would overflow', () => {
    // 'aaaa bbbb cccc' at width 10 → 'aaaa bbbb' + 'cccc'
    expect(wrappedRowCount('aaaa bbbb cccc', 10)).toBe(2);
  });

  test('hard-splits a word wider than the row', () => {
    expect(wrappedRowCount('a'.repeat(25), 10)).toBe(3);
  });

  test('a non-positive width never divides by zero', () => {
    expect(wrappedRowCount('anything', 0)).toBe(1);
  });
});

describe('composerRows', () => {
  test('grows with the newlines the user inserts', () => {
    expect(composerRows('', 40)).toBe(1);
    expect(composerRows('one', 40)).toBe(1);
    expect(composerRows('one\ntwo', 40)).toBe(2);
    expect(composerRows('one\ntwo\nthree', 40)).toBe(3);
  });

  test('stops at six rows', () => {
    const tall = Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n');
    expect(visualRowCount(tall, 40)).toBe(20);
    expect(composerRows(tall, 40)).toBe(COMPOSER_MAX_ROWS);
  });

  test('counts wrapping, not just newlines', () => {
    expect(composerRows('a'.repeat(120), 40)).toBe(3);
  });
});

describe('isSlashTrigger', () => {
  test('column 0 of an empty buffer opens the picker', () => {
    expect(isSlashTrigger('', 0)).toBe(true);
  });

  test('column 0 of a later line opens the picker', () => {
    expect(isSlashTrigger('run this\n', 9)).toBe(true);
  });

  test('mid-line slashes stay text — `cd /workspace` must be typeable', () => {
    expect(isSlashTrigger('cd ', 3)).toBe(false);
    expect(isSlashTrigger('half', 4)).toBe(false);
  });

  test('an out-of-range cursor is clamped, never thrown on', () => {
    expect(isSlashTrigger('abc', 99)).toBe(false);
    expect(isSlashTrigger('abc', -3)).toBe(true);
  });
});

describe('splitCommandInput', () => {
  test('splits the name from the arguments', () => {
    expect(splitCommandInput('/review the auth diff')).toEqual({
      name: 'review',
      args: 'the auth diff',
    });
  });

  test('a bare command has empty args', () => {
    expect(splitCommandInput('/new')).toEqual({ name: 'new', args: '' });
  });

  test('plain text is not a command', () => {
    expect(splitCommandInput('fix the bug')).toBeNull();
  });
});

describe('parseMentions', () => {
  test('finds a mention at the start and after whitespace', () => {
    expect(parseMentions('@src/app.tsx look at @docs/spec.md')).toEqual([
      { path: 'src/app.tsx', start: 0, end: 12 },
      { path: 'docs/spec.md', start: 21, end: 34 },
    ]);
  });

  test('an email address is not a mention', () => {
    expect(parseMentions('mail me at a@b.com')).toEqual([]);
  });
});

describe('insertNewline', () => {
  test('splits at the cursor and advances it', () => {
    expect(insertNewline('abcd', 2)).toEqual({ text: 'ab\ncd', cursorOffset: 3 });
  });

  test('clamps an out-of-range cursor', () => {
    expect(insertNewline('ab', 99)).toEqual({ text: 'ab\n', cursorOffset: 3 });
  });
});
