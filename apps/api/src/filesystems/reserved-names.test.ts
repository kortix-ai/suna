/**
 * The reserved-name list must not drift from the deadline middleware.
 *
 * A filesystem name is caller-chosen and appears in the URL path, and
 * `request-deadline.ts` matches its exemptions with `path.includes()` — so any
 * single-segment exemption there is a name that, if allowed, lets a caller
 * remove the 25 s deadline from their own requests. Adding a fragment to that
 * middleware without adding it here reopens the hole silently, so this test
 * reads the real list rather than a copy of it.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeFilesystemName, RESERVED_FILESYSTEM_NAMES } from './paths';

function exemptFragments(): string[] {
  const source = readFileSync(
    join(import.meta.dir, '..', 'middleware', 'request-deadline.ts'),
    'utf8',
  );
  const block = source.slice(
    source.indexOf('const EXEMPT_FRAGMENTS = ['),
    source.indexOf('];', source.indexOf('const EXEMPT_FRAGMENTS = [')),
  );
  return [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

describe('reserved filesystem names', () => {
  test('every SINGLE-SEGMENT deadline exemption is a reserved name', () => {
    const single = exemptFragments()
      .map((f) => f.replace(/^\/+|\/+$/g, ''))
      .filter((f) => f.length > 0 && !f.includes('/'));
    expect(single.length).toBeGreaterThan(0);
    const missing = single.filter((f) => !RESERVED_FILESYSTEM_NAMES.has(f));
    expect(missing).toEqual([]);
  });

  test('a reserved name is refused, case-insensitively', () => {
    for (const name of ['start', 'START', 'Provision', 'snapshots']) {
      const r = normalizeFilesystemName(name);
      expect(r.ok).toBe(false);
    }
  });

  test('an ordinary name that merely contains a reserved word is fine', () => {
    // Only the whole name matters: `start` in the path is what matches, and
    // `restart-notes` does not produce a `/start` path segment.
    for (const name of ['restart-notes', 'starters', 'provisioning-log']) {
      expect(normalizeFilesystemName(name).ok).toBe(true);
    }
  });
});
