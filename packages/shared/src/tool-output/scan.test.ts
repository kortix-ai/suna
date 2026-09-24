import { describe, expect, test } from 'bun:test';
import { isLineTerminator, isWhitespace, lineEnd } from './scan';

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

  test('lineEnd stops at the first terminator', () => {
    expect(lineEnd('ab\ncd', 0)).toBe(2);
    expect(lineEnd('ab\ncd', 3)).toBe(5);
    expect(lineEnd('a\rb', 0)).toBe(1);
  });
});
