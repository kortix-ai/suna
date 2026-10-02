import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import pg from 'pg';
import { SLOT_MS, countPass } from './audit-event-count-worker';

const databaseUrl = process.env.TEST_DATABASE_URL;
const ACCOUNT = 'c7100000-0000-4000-a000-000000000001';
const SLOT = SLOT_MS;
const HOUR = 60 * 60_000;

let client: pg.Client | null = null;
const q = <T extends pg.QueryResultRow = Record<string, unknown>>(
  text: string,
  values?: unknown[],
) => {
  if (!client) throw new Error('test client not connected');
  return client.query<T>(text, values);
};

/** One-row reads: a missing row fails the test with a clear message instead of
 * a TypeError deep in the assertion. */
const firstRow = <T extends pg.QueryResultRow>(result: pg.QueryResult<T>): T => {
  const row = result.rows[0];
  if (!row) throw new Error('expected one row, got none');
  return row;
};

/** The 5-minute slot an instant belongs to (UTC, epoch-aligned — the same
 * alignment the worker counts with). */
const slotStartOf = (ms: number) => Math.floor(ms / SLOT) * SLOT;
const iso = (ms: number) => new Date(ms).toISOString();

const slot = (start: number) =>
  q<{ events: string | number }>(
    'SELECT events FROM kortix.audit_event_counts WHERE slot_start = $1',
    [new Date(start)],
  );

describe.skipIf(!databaseUrl)('audit event count slots — migrated PostgreSQL', () => {
  // Pinned to a slot boundary so the pass's clock and the fixtures agree; the
  // worker reads the database clock in production, and a test that raced the
  // real one would flip its assertions whenever the run crossed a boundary.
  const NOW = slotStartOf(Date.now());

  beforeAll(async () => {
    client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    await q(
      `INSERT INTO kortix.accounts(account_id, name) VALUES ($1, 'audit-event-counts')
       ON CONFLICT (account_id) DO NOTHING`,
      [ACCOUNT],
    );
  });

  afterAll(async () => {
    if (!client) return;
    await q("SET kortix.audit_maintenance = 'on'");
    await q('DELETE FROM kortix.audit_events WHERE account_id = $1', [ACCOUNT]);
    await q('DELETE FROM kortix.audit_event_counts');
    await q('DELETE FROM kortix.accounts WHERE account_id = $1', [ACCOUNT]);
    await client.end();
  });

  test('countPass counts every closed slot exactly, skips the grace and the lookback, prunes', async () => {
    // Slots the pass MUST count: safely past the two-slot grace.
    const mustCountA = NOW - 3 * SLOT; // [now-15m, now-10m)
    const mustCountB = NOW - 4 * SLOT; // [now-20m, now-15m)
    // Slots the pass must NOT count yet: inside the two-slot grace, the open
    // slot, and older than the catch-up window.
    const inGrace = NOW - SLOT; // [now-5m, now)
    const openSlot = NOW;
    const beyondLookback = slotStartOf(NOW - 35 * HOUR);

    const insert = (at: number) =>
      q(
        `INSERT INTO kortix.audit_events(account_id, action, resource_type, authoritative_source, occurred_at)
         VALUES ($1, 'test.event-count', 'test', 'system', $2)`,
        [ACCOUNT, iso(at)],
      );
    // 3 rows in mustCountA, 1 in mustCountB, 2 in the grace slot, 1 open,
    // 1 beyond the lookback.
    for (const at of [mustCountA + 1, mustCountA + SLOT / 2, mustCountA + SLOT - 1]) {
      await insert(at);
    }
    await insert(mustCountB + 1);
    await insert(inGrace + 1);
    await insert(inGrace + SLOT - 1);
    await insert(openSlot + 1);
    await insert(beyondLookback);
    // A stale slot row the prune must remove.
    await q('INSERT INTO kortix.audit_event_counts(slot_start, events) VALUES ($1, 7)', [
      new Date(slotStartOf(NOW - 8 * 24 * HOUR)),
    ]);

    const result = await countPass(NOW);

    expect(result).toEqual({ counted: 12 }); // the work cap, not the slot count
    expect(Number(firstRow(await slot(mustCountA)).events)).toBe(3);
    expect(Number(firstRow(await slot(mustCountB)).events)).toBe(1);
    expect((await slot(inGrace)).rows).toHaveLength(0);
    expect((await slot(openSlot)).rows).toHaveLength(0);
    expect((await slot(beyondLookback)).rows).toHaveLength(0);
    // The stale row was pruned.
    expect(
      Number(
        firstRow(
          await q<{ n: number }>(
            `SELECT count(*)::int AS n FROM kortix.audit_event_counts
             WHERE slot_start < $1 - interval '7 days'`,
            [new Date(NOW)],
          ),
        ).n,
      ),
    ).toBe(0);

    // The dashboard read: the trailing 24 h of counted slots sums the fixture
    // exactly. Only mustCountA and mustCountB hold rows; the pass's other
    // counted slots were empty and contribute their zero.
    const dashboardSum = () =>
      q<{ count: number }>(
        `SELECT coalesce(sum(events), 0)::int AS count
         FROM kortix.audit_event_counts
        WHERE slot_start >= now() - interval '24 hours'`,
      );
    expect(Number(firstRow(await dashboardSum()).count)).toBe(4);

    // Re-running the pass with the same clock changes nothing for the counted
    // slots: counts are recomputed exactly, so concurrent replicas or a
    // restart cannot double-count. The next pass counts the NEXT missing
    // slots (still capped), never a second copy of these.
    const again = await countPass(NOW);
    expect(Number(firstRow(await slot(mustCountA)).events)).toBe(3);
    expect(Number(firstRow(await slot(mustCountB)).events)).toBe(1);
    expect(again.counted).toBeLessThanOrEqual(12);
    expect(Number(firstRow(await dashboardSum()).count)).toBe(4);
  });
});
