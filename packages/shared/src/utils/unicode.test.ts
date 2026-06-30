import { describe, test, expect } from 'bun:test';
import {
  normalizeFilenameToNFC,
  normalizePathToNFC,
  stripNullBytes,
  stripNullBytesDeep,
} from './unicode';

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

// Built via fromCharCode so this test file stays pure ASCII: a literal NUL byte
// in source would make it a binary file.
const NUL = String.fromCharCode(0);

describe('stripNullBytes', () => {
  test('returns a string with no NUL bytes unchanged (same reference)', () => {
    const input = 'hello world';
    expect(stripNullBytes(input)).toBe(input);
  });

  test('returns an empty string unchanged', () => {
    expect(stripNullBytes('')).toBe('');
  });

  test('removes a single embedded NUL byte', () => {
    expect(stripNullBytes(`a${NUL}b`)).toBe('ab');
  });

  test('removes multiple and consecutive NUL bytes', () => {
    expect(stripNullBytes(`${NUL}a${NUL}${NUL}b${NUL}`)).toBe('ab');
  });

  test('preserves other control characters and whitespace', () => {
    expect(stripNullBytes(`a\tb\nc ${NUL}d`)).toBe('a\tb\nc d');
  });

  test('result never contains a NUL byte', () => {
    expect(stripNullBytes(`x${NUL}y`).includes(NUL)).toBe(false);
  });
});

describe('stripNullBytesDeep', () => {
  test('passes through non-string primitives untouched', () => {
    expect(stripNullBytesDeep(42)).toBe(42);
    expect(stripNullBytesDeep(true)).toBe(true);
    expect(stripNullBytesDeep(null)).toBe(null);
    expect(stripNullBytesDeep(undefined)).toBe(undefined);
  });

  test('strips NUL from a bare string', () => {
    expect(stripNullBytesDeep(`a${NUL}b`)).toBe('ab');
  });

  test('strips NUL from strings nested in objects, arrays, and keys', () => {
    const dirty = {
      [`key${NUL}1`]: `val${NUL}ue`,
      nested: { messages: [`hi${NUL}`, { text: `to${NUL}ol` }] },
      clean: 7,
    };
    expect(stripNullBytesDeep(dirty)).toEqual({
      key1: 'value',
      nested: { messages: ['hi', { text: 'tool' }] },
      clean: 7,
    });
  });

  test('produces a value whose JSON serialization is free of the NUL escape', () => {
    const cleaned = stripNullBytesDeep({ body: `sys${NUL}prompt`, arr: [`a${NUL}`] });
    // JSON.stringify renders a NUL byte as the six-character token backslash-u-
    // 0000 — the exact escape Postgres jsonb rejects with 22P05. Build that token
    // escape-free (char 92 is backslash) and assert the serialization omits it.
    const NUL_JSON_ESCAPE = String.fromCharCode(92) + 'u0000';
    expect(JSON.stringify(cleaned).includes(NUL_JSON_ESCAPE)).toBe(false);
  });

  test('does not recurse into non-plain objects (e.g. Date) but keeps them', () => {
    const d = new Date(0);
    expect(stripNullBytesDeep({ when: d }).when).toBe(d);
  });

  test('leaves a fully clean object structurally equal', () => {
    const clean = { a: 1, b: ['x', 'y'], c: { d: 'z' } };
    expect(stripNullBytesDeep(clean)).toEqual(clean);
  });
});
