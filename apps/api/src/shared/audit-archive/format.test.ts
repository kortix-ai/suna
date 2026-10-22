import { describe, expect, test } from 'bun:test';
import {
  archiveObjectKey,
  decodeRows,
  encodeRows,
  isExpired,
  isReadyToArchive,
  manifestKey,
  retainUntil,
  weekEnd,
  weekStartOf,
} from './format';

const ACCOUNT = 'a7a00000-0000-4000-a000-000000000001';

describe('audit archive format', () => {
  test('weeks start on Monday 00:00 UTC', () => {
    expect(weekStartOf(new Date('2026-10-01T22:30:00Z'))).toBe('2026-09-28'); // Thursday
    expect(weekStartOf(new Date('2026-09-28T00:00:00Z'))).toBe('2026-09-28'); // Monday, first instant
    expect(weekStartOf(new Date('2026-10-04T23:59:59.999Z'))).toBe('2026-09-28'); // Sunday, last instant
    expect(weekEnd('2026-09-28').toISOString()).toBe('2026-10-05T00:00:00.000Z');
  });

  test('keys: one object family per account and week, parts zero-padded, no-account rows apart', () => {
    expect(archiveObjectKey(ACCOUNT, '2026-09-28', 0)).toBe(`audit/${ACCOUNT}/2026/2026-09-28.000.jsonl.gz`);
    expect(archiveObjectKey(ACCOUNT, '2026-09-28', 12)).toBe(`audit/${ACCOUNT}/2026/2026-09-28.012.jsonl.gz`);
    expect(archiveObjectKey(null, '2026-09-28', 0)).toBe('audit/_none/2026/2026-09-28.000.jsonl.gz');
    expect(manifestKey('2026-09-28')).toBe('audit/_manifest/2026-09-28.json');
  });

  test('retention runs until the end of the week plus 365 days', () => {
    expect(retainUntil('2026-09-28').toISOString()).toBe('2027-10-05T00:00:00.000Z');
  });

  test('a week is ready once its END is more than 90 days old, and expired once its lock would end within a day', () => {
    const end = weekEnd('2026-07-06').getTime(); // 2026-07-13
    expect(isReadyToArchive('2026-07-06', new Date(end + 90 * 86_400_000 - 1))).toBe(false);
    expect(isReadyToArchive('2026-07-06', new Date(end + 90 * 86_400_000 + 1))).toBe(true);
    expect(isExpired('2026-07-06', new Date(end + 363 * 86_400_000))).toBe(false);
    expect(isExpired('2026-07-06', new Date(end + 365 * 86_400_000 - 3_600_000))).toBe(true);
  });

  test('rows round-trip through gzip JSONL, and equal input gives equal bytes (a retry matches the stored object)', () => {
    const rows = [{ event_id: 'a', n: 1 }, { event_id: 'b', note: 'line\nbreak "quoted"' }];
    const first = encodeRows(rows.map((r) => JSON.stringify(r)));
    const again = encodeRows(rows.map((r) => JSON.stringify(r)));
    expect(first.rows).toBe(2);
    expect(first.sha256).toHaveLength(64);
    expect(first.bytes.equals(again.bytes)).toBe(true);
    expect(decodeRows(first.bytes)).toEqual(rows);
  });
});
