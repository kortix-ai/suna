import { describe, expect, test } from 'bun:test';
import { trashCutoff, versionPruned } from './maintenance';

describe('memory maintenance picks what to delete', () => {
  test('a page leaves the trash 30 days after its delete', () => {
    const now = new Date('2026-11-30T12:00:00.000Z');
    const cutoff = trashCutoff(now);
    expect(cutoff.toISOString()).toBe('2026-10-31T12:00:00.000Z');
    const deletedAt = (iso: string) => new Date(iso) < cutoff;
    expect(deletedAt('2026-10-31T11:59:59.999Z')).toBe(true);
    expect(deletedAt('2026-10-31T12:00:00.000Z')).toBe(false);
    expect(deletedAt('2026-11-29T12:00:00.000Z')).toBe(false);
  });

  test('a page keeps its newest 100 versions', () => {
    expect(versionPruned(1, 100)).toBe(false);
    expect(versionPruned(1, 101)).toBe(true);
    expect(versionPruned(2, 101)).toBe(false);
    expect(Array.from({ length: 250 }, (_, i) => i + 1).filter((n) => !versionPruned(n, 250))).toHaveLength(100);
  });
});
