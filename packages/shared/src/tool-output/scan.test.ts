import { describe, expect, test } from 'bun:test';
import {
  isDigit,
  isLineTerminator,
  isWhitespace,
  isWordCharacter,
  lineEnd,
  lineTables,
  positionIndex,
  startsWithIgnoreCase,
} from './scan';
import { chooser } from './testing';

describe('character classes', () => {
  test('isWhitespace is a regex \\s on every UTF-16 code unit', () => {
    for (let code = 0; code < 0x10000; code++) {
      expect(isWhitespace(code)).toBe(/\s/.test(String.fromCharCode(code)));
    }
  });

  test('isLineTerminator is what `.` refuses on every UTF-16 code unit', () => {
    for (let code = 0; code < 0x10000; code++) {
      expect(isLineTerminator(code)).toBe(!/./.test(String.fromCharCode(code)));
    }
  });

  test('isWordCharacter and isDigit are a regex \\w and \\d on every UTF-16 code unit', () => {
    for (let code = 0; code < 0x10000; code++) {
      const character = String.fromCharCode(code);
      expect(isWordCharacter(code)).toBe(/\w/.test(character));
      expect(isDigit(code)).toBe(/\d/.test(character));
    }
  });

  test('lineTables ends each run where the character class changes', () => {
    const t = lineTables('ab  c_d\r|');
    expect([...t.spaceEnd.slice(0, 10)]).toEqual([0, 1, 4, 4, 4, 5, 6, 8, 8, 9]);
    expect([...t.solidEnd.slice(0, 10)]).toEqual([2, 2, 2, 3, 7, 7, 7, 7, 9, 9]);
    expect([...t.wordEnd.slice(0, 10)]).toEqual([2, 2, 2, 3, 7, 7, 7, 7, 8, 9]);
    expect([...t.breakAt.slice(0, 10)]).toEqual([7, 7, 7, 7, 7, 7, 7, 7, 9, 9]);
  });

  test('positionIndex finds the nearest position where a predicate holds', () => {
    const { after, before } = positionIndex(5, (e) => e === 1 || e === 3);
    expect([...after.slice(0, 7)]).toEqual([1, 1, 3, 3, -1, -1, -1]);
    expect([...before]).toEqual([-1, 1, 1, 3, 3, 3]);
  });

  test('startsWithIgnoreCase folds ASCII letters only, as a regex i flag without u', () => {
    const { next, pick, some } = chooser(91);
    // ASCII needles, as the readers use. A non-ASCII character never folds to
    // ASCII without the u flag, so the Kelvin sign must not match a k.
    const needles = ['Status:', 'ses_', 'Prompt', 'k', 'Files read:'];
    let matched = 0;
    for (let i = 0; i < 3000; i++) {
      const needle = pick(needles);
      const prefix = some(['x', 'S', ':', ' '], 3);
      const cased = [...needle]
        .map((ch) => (next() < 0.5 ? ch.toUpperCase() : ch.toLowerCase()))
        .join('');
      const body = pick([
        cased,
        cased,
        needle.slice(0, -1),
        String.fromCharCode(0x212a) + needle.slice(1),
        'zzz',
      ]);
      const text = prefix + body + some(['x', ' '], 2);
      const at = prefix.length + pick([0, 0, 0, 1, -1]);
      const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const expected = at >= 0 && new RegExp(`^[\\s\\S]{${at}}${escaped}`, 'i').test(text);
      expect(startsWithIgnoreCase(text, needle, at)).toBe(expected);
      if (expected) matched++;
    }
    expect(matched).toBeGreaterThan(300);
  });

  test('lineEnd stops at the first terminator', () => {
    expect(lineEnd('ab\ncd', 0)).toBe(2);
    expect(lineEnd('ab\ncd', 3)).toBe(5);
    expect(lineEnd('a\rb', 0)).toBe(1);
  });
});
