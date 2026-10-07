import { expect, test } from 'bun:test';
import { conflictOriginal, driveVolumeName, normalizeDrivePath } from './access';

test('normalizeDrivePath refuses traversal and normalizes the rest', () => {
  expect(normalizeDrivePath('../etc/passwd')).toBeNull();
  expect(normalizeDrivePath('/a/../../b')).toBeNull();
  expect(normalizeDrivePath('a//b/')).toBe('/a/b');
  expect(normalizeDrivePath(undefined)).toBe('/');
});

test('driveVolumeName is a valid, stable volume name', () => {
  const name = driveVolumeName('0f8a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b');
  expect(name).toBe('kd-0f8a2b3c4d5e4f608a9b');
  expect(name).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/);
});

test('conflictOriginal recognizes both merge and in-sandbox conflict copies', () => {
  expect(conflictOriginal('/notes/plan (conflict 2026-10-01 1405).md')).toBe('/notes/plan.md');
  expect(conflictOriginal('/a/plan (conflict 2026-10-01 1405 a3f9).md')).toBe('/a/plan.md');
  expect(conflictOriginal('/a/plan (conflict 2026-10-01 1405 2).md')).toBe('/a/plan.md');
  expect(conflictOriginal('/db/app (conflict 2026-10-01 1405).db')).toBe('/db/app.db');
  expect(conflictOriginal('/a/plan (conflict notes).md')).toBeNull();
  expect(conflictOriginal('/a (conflict 2026-10-01 1405)/plan.md')).toBeNull();
});
