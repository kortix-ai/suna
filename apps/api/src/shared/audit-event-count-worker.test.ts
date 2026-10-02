import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * Mocked db.execute for the count pass. Every statement is rendered to real
 * SQL with its params (PgDialect), so the assertions below pin the actual
 * slot bounds and slot values, not merely "a query was built".
 */
type Call = { sql: string; params: unknown[] };

let calls: Call[] = [];
let existingSlots: string[] = [];
let slotCounts: number[] = [];

mock.module('./db', () => ({
  db: {
    execute: async (query: SQL) => {
      // Rendered SQL keeps the template's leading whitespace; trim it so the
      // branch matchers below can startWith the statement kind.
      const { sql: raw, params } = new PgDialect().sqlToQuery(query);
      const text = raw.trim();
      const call = { sql: text, params };
      calls.push(call);
      if (text.includes('SELECT now(')) return [{ now: NOW }];
      if (text.includes('SELECT slot_start FROM')) {
        return existingSlots.map((slot_start) => ({ slot_start }));
      }
      if (text.includes('count(*)::bigint')) return [{ count: slotCounts.shift() ?? 0 }];
      if (text.startsWith('INSERT INTO') || text.startsWith('DELETE FROM')) return [];
      throw new Error(`unexpected query: ${text}`);
    },
  },
}));

const NOW = new Date('2026-10-02T22:00:00.000Z');
const SLOT = 5 * 60_000;

const { countPass, pendingSlotStarts, slotStartOf, SLOT_MS, GRACE_SLOTS, MAX_SLOTS_PER_TICK } =
  await import('./audit-event-count-worker');

const slotStart = (minutesAfter: number) => NOW.getTime() + minutesAfter * 60_000;

beforeEach(() => {
  calls = [];
  existingSlots = [];
  slotCounts = [];
});

describe('slotStartOf', () => {
  test('floors to the slot boundary', () => {
    expect(new Date(slotStartOf(slotStart(3.7))).toISOString()).toBe('2026-10-02T22:00:00.000Z');
    expect(new Date(slotStartOf(slotStart(-3.7))).toISOString()).toBe('2026-10-02T21:55:00.000Z');
  });

  test('is stable on the boundary itself', () => {
    expect(slotStartOf(slotStart(0))).toBe(slotStart(0));
    expect(slotStartOf(slotStart(5))).toBe(slotStart(5));
  });
});

describe('pendingSlotStarts', () => {
  test('starts two slots after the current one (the late-row grace) and walks back newest first', () => {
    const pending = pendingSlotStarts(NOW.getTime(), new Set());
    const [newest, next] = pending;
    if (!newest || !next) throw new Error('expected at least two pending slots');
    expect(new Date(newest).toISOString()).toBe('2026-10-02T21:50:00.000Z');
    expect(new Date(next).toISOString()).toBe('2026-10-02T21:45:00.000Z');
  });

  test('skips slots that already have a count', () => {
    const counted = new Set([
      slotStart(-GRACE_SLOTS * 5),
      slotStart(-GRACE_SLOTS * 5 - SLOT / 60_000),
    ]);
    const pending = pendingSlotStarts(NOW.getTime(), counted);
    expect(pending).not.toContain(slotStart(-GRACE_SLOTS * 5));
    expect(pending).toContain(slotStart(-GRACE_SLOTS * 5 - 2 * (SLOT / 60_000)));
  });

  test('stops at the lookback window, not at history the dashboard never reads', () => {
    const pending = pendingSlotStarts(NOW.getTime(), new Set(), { max: 10_000 });
    const oldest = pending.at(-1);
    if (!oldest) throw new Error('expected pending slots');
    // 26 h lookback: the oldest eligible slot start is at least 25 h old and
    // at most 26 h old.
    expect(NOW.getTime() - oldest).toBeGreaterThan(25 * 60 * 60_000);
    expect(NOW.getTime() - oldest).toBeLessThanOrEqual(26 * 60 * 60_000);
  });

  test('caps the work a single pass may do', () => {
    const pending = pendingSlotStarts(NOW.getTime(), new Set());
    expect(pending).toHaveLength(MAX_SLOTS_PER_TICK);
  });
});

describe('countPass', () => {
  test('counts every missing slot once, upserts its exact value, and prunes', async () => {
    // Every eligible slot is already counted except the three newest; the
    // pass must count exactly those three and stop.
    for (let minutes = -GRACE_SLOTS * 5 - 15; minutes >= -(26 * 60); minutes -= 5) {
      existingSlots.push(new Date(slotStart(minutes)).toISOString());
    }
    slotCounts = [11, 22, 33];

    const result = await countPass();

    expect(result).toEqual({ counted: 3 });
    const countQueries = calls.filter((call) => call.sql.includes('count(*)::bigint'));
    expect(countQueries).toHaveLength(3);
    // Each count is bounded to its own slot: [start, start+5m).
    for (const [index, call] of countQueries.entries()) {
      const start = new Date(call.params[0] as string | Date);
      const end = new Date(call.params[1] as string | Date);
      expect(end.getTime() - start.getTime()).toBe(SLOT_MS);
      expect(start.getTime()).toBe(slotStart((-GRACE_SLOTS - index) * 5));
      expect(call.sql).toContain('FROM kortix.audit_events');
    }
    const inserts = calls.filter((call) => call.sql.startsWith('INSERT INTO'));
    expect(inserts).toHaveLength(3);
    // Newest slot first; the scripted counts were served in that order.
    expect(inserts.map((call) => Number(call.params[1]))).toEqual([11, 22, 33]);
    expect(calls.some((call) => call.sql.startsWith('DELETE FROM kortix.audit_event_counts'))).toBe(
      true,
    );
  });

  test('counts nothing when every eligible slot already has a value', async () => {
    // Cover the whole catch-up window (26 h of slots, grace included) so the
    // pass finds nothing to do.
    for (let minutes = -GRACE_SLOTS * 5; minutes >= -(26 * 60); minutes -= 5) {
      existingSlots.push(new Date(slotStart(minutes)).toISOString());
    }
    const result = await countPass();
    expect(result).toEqual({ counted: 0 });
    expect(calls.some((call) => call.sql.includes('count(*)::bigint'))).toBe(false);
    // The prune still runs so the table cannot grow without bound.
    expect(calls.some((call) => call.sql.startsWith('DELETE FROM'))).toBe(true);
  });
});
