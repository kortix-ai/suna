import { describe, test, expect } from 'bun:test';
import { normalizeFilenameToNFC, normalizePathToNFC } from './unicode';

const UNICODE_SPACE_CODE_POINTS = [
  0x00a0, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
  0x2008, 0x2009, 0x200a, 0x202f, 0x205f, 0x3000,
];

const NBSP = String.fromCharCode(0x00a0);
const NARROW_NBSP = String.fromCharCode(0x202f);
const COMBINING_ACUTE = String.fromCharCode(0x0301);
const E_ACUTE = String.fromCharCode(0x00e9);

const E_DECOMPOSED = 'e' + COMBINING_ACUTE;
const CAFE_DECOMPOSED = 'caf' + E_DECOMPOSED;
const CAFE_COMPOSED = 'caf' + E_ACUTE;

describe('normalizeFilenameToNFC', () => {
  test('returns a plain ascii filename unchanged', () => {
    expect(normalizeFilenameToNFC('report.pdf')).toBe('report.pdf');
  });

  test('returns an empty string unchanged', () => {
    expect(normalizeFilenameToNFC('')).toBe('');
  });

  test('normalizes decomposed unicode to composed form', () => {
    expect(normalizeFilenameToNFC(`${CAFE_DECOMPOSED}.txt`)).toBe(`${CAFE_COMPOSED}.txt`);
  });

  test('produces identical output for decomposed and composed inputs', () => {
    expect(normalizeFilenameToNFC(`${CAFE_DECOMPOSED}.txt`)).toBe(
      normalizeFilenameToNFC(`${CAFE_COMPOSED}.txt`),
    );
  });

  test('replaces every known unicode space with a regular ascii space', () => {
    for (const codePoint of UNICODE_SPACE_CODE_POINTS) {
      const space = String.fromCharCode(codePoint);
      expect(normalizeFilenameToNFC(`a${space}b`)).toBe('a b');
    }
  });

  test('replaces a narrow no-break space before PM in a screenshot name', () => {
    expect(normalizeFilenameToNFC(`shot${NARROW_NBSP}PM.png`)).toBe('shot PM.png');
  });

  test('replaces multiple unicode spaces in one filename', () => {
    expect(normalizeFilenameToNFC(`a${NBSP}b${NBSP}c`)).toBe('a b c');
  });

  test('preserves a regular ascii space', () => {
    expect(normalizeFilenameToNFC('a b c')).toBe('a b c');
  });

  test('is idempotent for already-normalized input', () => {
    const normalized = normalizeFilenameToNFC(`${CAFE_DECOMPOSED}${NBSP}file.txt`);
    expect(normalizeFilenameToNFC(normalized)).toBe(normalized);
  });
});

describe('normalizePathToNFC', () => {
  test('returns a plain ascii path unchanged', () => {
    expect(normalizePathToNFC('/home/user/file.txt')).toBe('/home/user/file.txt');
  });

  test('returns an empty path unchanged', () => {
    expect(normalizePathToNFC('')).toBe('');
  });

  test('normalizes decomposed unicode path segments to composed form', () => {
    expect(normalizePathToNFC(`/users/${CAFE_DECOMPOSED}`)).toBe(`/users/${CAFE_COMPOSED}`);
  });

  test('does not convert unicode spaces in paths', () => {
    expect(normalizePathToNFC(`/a${NBSP}b`)).toBe(`/a${NBSP}b`);
  });

  test('is idempotent for already-normalized input', () => {
    const normalized = normalizePathToNFC(`/users/${CAFE_DECOMPOSED}`);
    expect(normalizePathToNFC(normalized)).toBe(normalized);
  });
});
