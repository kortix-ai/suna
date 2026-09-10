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

  // The transport already percent-decodes (`?path=` through Hono), so decoding
  // again here made `a%252Fb` and `a/b` collide on one key — measured as real
  // data loss on the deployed preview. An encoded separator that survives to
  // this layer is a mistake or an attempt, so it is REFUSED, never decoded.
  test('percent-encoded traversal and separators are refused, not decoded', () => {
    expect(rejected('%2e%2e/secrets')).toMatch(/percent-encoded|\.\./);
    expect(rejected('a/%2E%2E/b')).toMatch(/percent-encoded|\.\./);
    expect(rejected('a%2Fb')).toMatch(/percent-encoded/);
    expect(rejected('a%5Cb')).toMatch(/percent-encoded/);
  });

  test('an ordinary percent in a filename still survives', () => {
    // `50%25.md` arrives here already decoded as `50%.md`; nothing about it
    // decodes to a separator, so it is a legitimate name.
    expect(ok('reports/50%.md')).toBe('reports/50%.md');
  });

  test('backslash traversal is refused — a backslash is a separator too', () => {
    expect(rejected('..\\secrets')).toMatch(/\.\./);
    expect(ok('a\\b')).toBe('a/b');
  });

  test('a NUL byte is refused, encoded or raw', () => {
    expect(rejected('a\0b')).toMatch(/NUL/);
    expect(rejected('a%00b')).toMatch(/NUL/);
  });

  test('a malformed encoded-separator sequence is refused', () => {
    // Only sequences that LOOK like an encoded separator are probed, so a bare
    // `%zz` is an ordinary (if odd) filename, while `%2f%zz` cannot be decoded
    // to prove it is safe.
    expect(ok('%zz')).toBe('%zz');
    expect(rejected('%2f%zz')).toMatch(/percent-encoding|percent-encoded/);
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
