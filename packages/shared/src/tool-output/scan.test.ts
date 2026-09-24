import { describe, expect, test } from 'bun:test';
import {
  isDigit,
  isLineTerminator,
  isWhitespace,
  isWordCharacter,
  lineEnd,
  lineTables,
  positionIndex,
} from './scan';

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

  test('lineEnd stops at the first terminator', () => {
    expect(lineEnd('ab\ncd', 0)).toBe(2);
    expect(lineEnd('ab\ncd', 3)).toBe(5);
    expect(lineEnd('a\rb', 0)).toBe(1);
  });
});
