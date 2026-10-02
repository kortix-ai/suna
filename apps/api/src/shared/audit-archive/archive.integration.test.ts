import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import pg from 'pg';
import { db } from '../db';
import { type ArchiveStore, exportWeek, runArchivePass } from './archive';
import { decodeRows, retainUntil, weekEnd, weekStartOf } from './format';

const databaseUrl = process.env.TEST_DATABASE_URL;
const A1 = 'b9200000-0000-4000-a000-000000000001';
const A2 = 'b9200000-0000-4000-a000-000000000002';
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

interface Stored { body: Buffer; retainUntil: Date; mode: string }

function fakeStore() {
  const objects = new Map<string, Stored>();
  const store: ArchiveStore & { objects: Map<string, Stored>; corrupt: Set<string> } = {
    objects,
    corrupt: new Set(),
    async putLocked(input) {
      if (objects.has(input.key)) return 'exists';
      objects.set(input.key, { body: input.body, retainUntil: input.retainUntil, mode: input.mode });
      return 'created';
    },
    async checksum(key) {
      const object = objects.get(key);
      if (!object) return null;
      if (store.corrupt.has(key)) return 'AAAA';
      return createHash('sha256').update(object.body).digest('base64');
    },
  };
  return store;
}

let client: pg.Client | null = null;
const q = (text: string, values?: unknown[]) => client!.query(text, values);

async function seed(accountId: string | null, action: string, at: string, n = 1) {
  await q(
    `INSERT INTO kortix.audit_events(account_id, action, resource_type, authoritative_source, occurred_at)
     SELECT $1, $2, 'test', 'system', $3::timestamptz + g * interval '1 second' FROM generate_series(1, $4) g`,
    [accountId, action, at, n],
  );
}

describe.skipIf(!databaseUrl)('audit archive — export, verify, remove (real PostgreSQL, in-memory store)', () => {
  const w1 = weekStartOf(new Date(Date.now() - 170 * DAY));
  const w2 = weekStartOf(new Date(Date.now() - 150 * DAY));
  const w3 = weekStartOf(new Date(Date.now() - 130 * DAY));
  const deps = (store: ArchiveStore, extra: Record<string, unknown> = {}) => ({
    db, store, mode: 'COMPLIANCE' as const, rowsPerSecond: 1_000_000, batchRows: 3, ...extra,
  });

  beforeAll(async () => {
    client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    // Weeks far enough back to be archivable exist as partitions (the migration keeps 85 days).
    await q(`SELECT kortix.audit_events_ensure_partitions('kortix.audit_events', current_date - 200, 8)`);
    // Old history lives in the legacy table; w1 also has late rows in its partition; w3 only in a partition.
    await q(`INSERT INTO kortix.audit_events_legacy(account_id, action, resource_type, authoritative_source, occurred_at)
             SELECT a, 'legacy.row', 'test', 'system', $1::timestamptz + g * interval '1 minute'
               FROM unnest($2::uuid[]) a, generate_series(1, 4) g`, [daysAgo(170), [A1, A2]]);
    await q(`INSERT INTO kortix.audit_events_legacy(account_id, action, resource_type, authoritative_source, occurred_at)
             VALUES (NULL, 'legacy.anonymous', 'test', 'system', $1), ($2, 'legacy.w2', 'test', 'system', $3)`, [daysAgo(170), A1, daysAgo(150)]);
    await seed(A1, 'late.row', daysAgo(169), 2);
    await seed(A2, 'partition.w3', daysAgo(130), 5);
    await seed(A1, 'partition.hot', daysAgo(1), 3);
  });

  afterAll(async () => {
    if (!client) return;
    await q(`SET kortix.audit_maintenance = 'on'`);
    await q(`DELETE FROM kortix.audit_events WHERE account_id = ANY($1::uuid[])`, [[A1, A2]]);
    await q(`DELETE FROM kortix.audit_archive_chunks`);
    await client.end();
  });

  test('a corrupted upload stops the week before anything is removed', async () => {
    const store = fakeStore();
    const original = store.putLocked.bind(store);
    store.putLocked = async (input) => {
      const outcome = await original(input);
      if (input.key.includes(`/${w3}.`)) store.corrupt.add(input.key);
      return outcome;
    };
    await expect(exportWeek(deps(store), w3)).rejects.toThrow(/does not match the exported rows/);
    const chunk = await q(`SELECT status FROM kortix.audit_archive_chunks WHERE week_start = $1`, [w3]);
    expect(chunk.rows[0]?.status).toBe('exporting');
    const held = await q(`SELECT count(*)::int AS n FROM kortix.audit_events WHERE action = 'partition.w3'`);
    expect(held.rows[0].n).toBe(5);
  });

  test('exports one object family per account and week, with Object Lock until week end + 365 days', async () => {
    const store = fakeStore();
    const result = await exportWeek(deps(store), w3);
    expect(result.rows).toBe(5);
    expect(result.legacyRows).toBe(0);
    const keys = [...store.objects.keys()].sort();
    expect(keys).toEqual([`audit/${A2}/${w3.slice(0, 4)}/${w3}.000.jsonl.gz`, `audit/_manifest/${w3}.json`].sort());
    for (const object of store.objects.values()) {
      expect(object.mode).toBe('COMPLIANCE');
      expect(object.retainUntil.getTime()).toBe(retainUntil(w3).getTime());
    }
    const lines = decodeRows(store.objects.get(keys.find((k) => k.endsWith('.jsonl.gz'))!)!.body);
    expect(lines).toHaveLength(5);
    expect(lines.every((row) => row.account_id === A2 && row.action === 'partition.w3')).toBe(true);
    // Ascending by (occurred_at, event_id).
    const times = lines.map((row) => new Date(String(row.occurred_at)).getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
    // A second export of the same week writes nothing new and still verifies.
    const again = await exportWeek(deps(store), w3);
    expect(again.manifestSha256).toBe(result.manifestSha256);
    expect(store.objects.size).toBe(2);
  });

  test('the export is rate-capped: batches never finish faster than rows / rowsPerSecond', async () => {
    const sleeps: number[] = [];
    const store = fakeStore();
    await exportWeek(deps(store, { rowsPerSecond: 10, batchRows: 2, sleep: async (ms: number) => void sleeps.push(ms) }), w3);
    // 5 rows in batches of 2: three batches, each owed >= (rows / 10 s) minus the time it took.
    expect(sleeps.length).toBe(3);
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThan(400);
  });

  test('a pass archives every old week, retires the legacy table, and drops the archived partitions', async () => {
    const store = fakeStore();
    const result = await runArchivePass(deps(store), Date.now() + 120_000);
    expect(result.archived).toEqual(expect.arrayContaining([w1, w2]));
    expect(result.legacyRetired).toBe(true);

    // w3 (5 rows) was archived by an earlier test with its own store. This pass wrote the rest:
    // 8 + 1 + 1 legacy rows and 2 late rows.
    let archived = 0;
    for (const [key, object] of store.objects) {
      if (key.includes('_manifest')) continue;
      archived += decodeRows(object.body).length;
    }
    expect(archived).toBe(8 + 1 + 1 + 2);
    expect([...store.objects.keys()].some((k) => k.startsWith('audit/_none/'))).toBe(true);

    // PostgreSQL: the legacy table and the old partitions are gone, the hot rows remain.
    expect((await q(`SELECT to_regclass('kortix.audit_events_legacy') AS r`)).rows[0].r).toBeNull();
    expect((await q(`SELECT to_regclass('kortix.audit_events_p${w1.replaceAll('-', '')}') AS r`)).rows[0].r).toBeNull();
    const view = await q(`SELECT count(*)::int AS n FROM kortix.audit_events_all WHERE account_id = ANY($1::uuid[])`, [[A1, A2]]);
    expect(view.rows[0].n).toBe(3);
    const statuses = await q(`SELECT DISTINCT status FROM kortix.audit_archive_chunks WHERE week_start = ANY($1::date[])`, [[w1, w2, w3]]);
    expect(statuses.rows.map((r) => r.status)).toEqual(['removed']);

    // The week the partition path removes (w3) and a rerun do nothing more.
    const again = await runArchivePass(deps(store), Date.now() + 120_000);
    expect(again).toEqual({ archived: [], removed: [], expired: [], legacyRetired: false });
  });

  test('after the legacy table is gone, a pass archives a partition week and then drops it (detach, recount, drop)', async () => {
    const w4 = weekStartOf(new Date(Date.now() - 120 * DAY));
    // The earlier pass already archived and dropped this (empty) week; bring it back with 4 rows.
    await q(`DELETE FROM kortix.audit_archive_chunks WHERE week_start = $1`, [w4]);
    await q(`SELECT kortix.audit_events_ensure_partitions('kortix.audit_events', current_date - 125, 0)`);
    await seed(A2, 'partition.w4', daysAgo(120), 4);
    const store = fakeStore();
    const result = await runArchivePass(deps(store), Date.now() + 120_000);
    expect(result.archived).toContain(w4);
    expect(result.removed).toContain(w4);
    expect((await q(`SELECT to_regclass('kortix.audit_events_p${w4.replaceAll('-', '')}') AS r`)).rows[0].r).toBeNull();
    const gone = await q(`SELECT count(*)::int AS n FROM kortix.audit_events_all WHERE action = 'partition.w4'`);
    expect(gone.rows[0].n).toBe(0); // served from the archive now
    const archived = [...store.objects].filter(([k]) => k.includes(`/${w4}.0`)).flatMap(([, o]) => decodeRows(o.body));
    expect(archived).toHaveLength(4);
  });

  test('a week past the 365-day retention that was never exported is dropped, not exported', async () => {
    const old = weekStartOf(new Date(Date.now() - 400 * DAY));
    await q(`SELECT kortix.audit_events_ensure_partitions('kortix.audit_events', current_date - 410, 0)`);
    const store = fakeStore();
    const result = await runArchivePass(deps(store), Date.now() + 120_000);
    expect(result.expired).toContain(old);
    expect([...store.objects.keys()].some((k) => k.includes(old))).toBe(false);
    expect(weekEnd(old).getTime()).toBeLessThan(Date.now() - 365 * DAY + DAY * 7);
  });
});
