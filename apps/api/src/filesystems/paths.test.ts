import { describe, expect, test } from 'bun:test';
import {
  MAX_PATH_SEGMENTS,
  normalizeFilePath,
  normalizeFilesystemName,
  normalizeListPrefix,
} from './paths';

const ok = (raw: string) => {
  const r = normalizeFilePath(raw);
  if (!r.ok) throw new Error(`expected ok, got: ${r.reason}`);
  return r.path;
};
const rejected = (raw: string) => {
  const r = normalizeFilePath(raw);
  return r.ok ? null : r.reason;
};

describe('file paths are canonical', () => {
  test('the same file has exactly one key', () => {
    expect(ok('notes/plan.md')).toBe('notes/plan.md');
    expect(ok('/notes/plan.md')).toBe('notes/plan.md');
    expect(ok('notes//plan.md')).toBe('notes/plan.md');
    expect(ok('./notes/./plan.md')).toBe('notes/plan.md');
    expect(ok('notes/plan.md/')).toBe('notes/plan.md');
  });

  test('a single path segment is fine', () => {
    expect(ok('MEMORY.md')).toBe('MEMORY.md');
  });

  test('unicode and spaces survive — they are ordinary filenames', () => {
    expect(ok('notes/día uno.md')).toBe('notes/día uno.md');
  });
});

describe('traversal is rejected, never rewritten', () => {
  // Silently rewriting `../shared/x` to `shared/x` would hand the agent a
  // DIFFERENT file than it asked for. Refusing says so.
  test('.. in any position is refused', () => {
    for (const p of ['../x', 'a/../b', 'a/b/..', '..', 'a/../../b']) {
      expect(rejected(p)).toMatch(/\.\./);
    }
  });

  test('percent-encoded traversal is refused — decoding happens BEFORE the check', () => {
    expect(rejected('%2e%2e/secrets')).toMatch(/\.\./);
    expect(rejected('a/%2E%2E/b')).toMatch(/\.\./);
  });

  test('backslash traversal is refused — a backslash is a separator too', () => {
    expect(rejected('..\\secrets')).toMatch(/\.\./);
    expect(ok('a\\b')).toBe('a/b');
  });

  test('a NUL byte is refused, encoded or raw', () => {
    expect(rejected('a\0b')).toMatch(/NUL/);
    expect(rejected('a%00b')).toMatch(/NUL/);
  });

  test('malformed percent-encoding is refused rather than passed through', () => {
    expect(rejected('%zz')).toMatch(/percent-encoding/);
  });
});

describe('bounds', () => {
  test('an empty path is refused', () => {
    for (const p of ['', '/', '.', './', '//']) expect(rejected(p)).toMatch(/empty/);
  });

  test('absurd depth and length are refused', () => {
    expect(rejected(Array(MAX_PATH_SEGMENTS + 2).fill('a').join('/'))).toMatch(/segments/);
    expect(rejected(`${'a'.repeat(1100)}.md`)).toMatch(/characters/);
  });
});

describe('filesystem names', () => {
  test('plain names pass', () => {
    for (const n of ['notes', 'shared-state', 'team.memory', 'fs_1', 'a']) {
      const r = normalizeFilesystemName(n);
      expect(r.ok).toBe(true);
    }
  });

  test('anything that would complicate a URL or a shell is refused', () => {
    for (const n of ['', ' ', '-leading', '.hidden', 'has/slash', 'has space', 'a'.repeat(129)]) {
      expect(normalizeFilesystemName(n).ok).toBe(false);
    }
  });

  test('surrounding whitespace is trimmed, not rejected', () => {
    const r = normalizeFilesystemName('  notes  ');
    expect(r.ok && r.path).toBe('notes');
  });
});

describe('list prefixes', () => {
  test('empty means everything', () => {
    for (const p of [undefined, null, '']) {
      const r = normalizeListPrefix(p as string | undefined);
      expect(r.ok && r.path).toBe('');
    }
  });

  test('a prefix always ends at a segment boundary, so `not` cannot match `notes/x`', () => {
    const r = normalizeListPrefix('not');
    expect(r.ok && r.path).toBe('not/');
  });

  test('traversal in a prefix is refused too', () => {
    expect(normalizeListPrefix('../etc').ok).toBe(false);
  });
});
