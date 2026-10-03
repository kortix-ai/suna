import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;
const ACCOUNT = 'a7800000-0000-4000-a000-000000000001';
const DAY = 86_400_000;

let client: pg.Client | null = null;
const q = <T extends pg.QueryResultRow = Record<string, unknown>>(text: string, values?: unknown[]) =>
  client!.query<T>(text, values);
const iso = (ms: number) => new Date(ms).toISOString();

async function connect(): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: databaseUrl });
  await c.connect();
  return c;
}

describe.skipIf(!databaseUrl)('kortix.audit_events — weekly range partitions on occurred_at', () => {
  beforeAll(async () => {
    client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    await q(
      `INSERT INTO kortix.accounts(account_id, name) VALUES ($1, 'audit-partitioned')
       ON CONFLICT (account_id) DO NOTHING`,
      [ACCOUNT],
    );
  });

  afterAll(async () => {
    if (!client) return;
    await q(`SET kortix.audit_maintenance = 'on'`);
    await q(`DELETE FROM kortix.audit_events WHERE account_id = $1`, [ACCOUNT]);
    await q(`DELETE FROM kortix.audit_events_legacy WHERE account_id = $1`, [ACCOUNT]);
    await q(`DELETE FROM kortix.audit_webhooks WHERE account_id = $1`, [ACCOUNT]);
    await q(`DELETE FROM kortix.accounts WHERE account_id = $1`, [ACCOUNT]);
    await client.end();
  });

  test('is range-partitioned by occurred_at with contiguous Monday-aligned weekly partitions', async () => {
    const parent = await q<{ strategy: string; key: string }>(
      `SELECT pt.partstrat AS strategy, a.attname AS key
         FROM pg_partitioned_table pt
         JOIN pg_attribute a ON a.attrelid = pt.partrelid AND a.attnum = pt.partattrs[0]
        WHERE pt.partrelid = 'kortix.audit_events'::regclass`,
    );
    expect(parent.rows).toEqual([{ strategy: 'r', key: 'occurred_at' }]);

    const bounds = await q<{ lo: Date; hi: Date }>(
      `SELECT (regexp_match(pg_get_expr(c.relpartbound, c.oid), 'FROM \\(''([^'']+)''\\)'))[1]::timestamptz AS lo,
              (regexp_match(pg_get_expr(c.relpartbound, c.oid), 'TO \\(''([^'']+)''\\)'))[1]::timestamptz AS hi
         FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
        WHERE i.inhparent = 'kortix.audit_events'::regclass
          AND pg_get_expr(c.relpartbound, c.oid) <> 'DEFAULT'
        ORDER BY 1`,
    );
    expect(bounds.rows.length).toBeGreaterThanOrEqual(20);
    for (const [index, row] of bounds.rows.entries()) {
      expect(row.lo.getUTCDay()).toBe(1); // Monday
      expect(row.lo.getUTCHours() + row.lo.getUTCMinutes()).toBe(0);
      expect(row.hi.getTime() - row.lo.getTime()).toBe(7 * DAY);
      if (index > 0) expect(row.lo.getTime()).toBe(bounds.rows[index - 1]!.hi.getTime()); // no gap
    }
    // Covers the 80-day late-row window and at least 7 weeks ahead.
    expect(bounds.rows[0]!.lo.getTime()).toBeLessThanOrEqual(Date.now() - 80 * DAY);
    expect(bounds.rows.at(-1)!.hi.getTime()).toBeGreaterThanOrEqual(Date.now() + 7 * 7 * DAY);
  });

  test('primary key and the dedupe index carry the partition key', async () => {
    const pk = await q<{ cols: string }>(
      `SELECT string_agg(a.attname, ',' ORDER BY k.ord) AS cols
         FROM pg_constraint c
         CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
        WHERE c.conrelid = 'kortix.audit_events'::regclass AND c.contype = 'p'`,
    );
    expect(pk.rows[0]?.cols).toBe('event_id,occurred_at');
    const dedupe = await q<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'kortix' AND tablename = 'audit_events'
          AND indexname = 'idx_audit_events_source_phase'`,
    );
    expect(dedupe.rows[0]?.indexdef).toMatch(/UNIQUE/);
    expect(dedupe.rows[0]?.indexdef).toMatch(/occurred_at/);
  });

  test('a row lands in the partition of its week', async () => {
    const now = Date.now();
    const rows = await q<{ occurred_at: Date; partition: string }>(
      `INSERT INTO kortix.audit_events(account_id, action, resource_type, authoritative_source, occurred_at)
       VALUES ($1, 'test.partition.route', 'test', 'system', $2),
              ($1, 'test.partition.route', 'test', 'system', $3)
       RETURNING occurred_at, tableoid::regclass::text AS partition`,
      [ACCOUNT, iso(now), iso(now - 21 * DAY)],
    );
    const week = (ms: number) => {
      const d = new Date(ms);
      d.setUTCHours(0, 0, 0, 0);
      d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
      return `kortix.audit_events_p${d.toISOString().slice(0, 10).replaceAll('-', '')}`;
    };
    expect(rows.rows.map((r) => r.partition).sort()).toEqual([week(now), week(now - 21 * DAY)].sort());
  });

  test('dedupe: a replayed source record inserts once, even from 8 concurrent connections', async () => {
    const occurredAt = iso(Date.now() - 2 * DAY);
    const insert = (c: pg.Client, record: string, at = occurredAt) =>
      c.query(
        `INSERT INTO kortix.audit_events
           (account_id, action, resource_type, authoritative_source, source_ledger, source_record_id,
            phase, source_revision, occurred_at)
         VALUES ($1, 'test.partition.dedupe', 'test', 'system', 'partition_test', $2, 'completed', 'r1', $3)
         ON CONFLICT DO NOTHING RETURNING event_id`,
        [ACCOUNT, record, at],
      );
    expect((await insert(client!, 'a')).rowCount).toBe(1);
    expect((await insert(client!, 'a')).rowCount).toBe(0);
    // The same tuple at another instant is another row: occurred_at is part of the key.
    expect((await insert(client!, 'a', iso(Date.now() - 3 * DAY))).rowCount).toBe(1);

    const writers = await Promise.all(Array.from({ length: 8 }, connect));
    try {
      const results = await Promise.all(writers.map((writer) => insert(writer, 'race')));
      expect(results.reduce((total, result) => total + (result.rowCount ?? 0), 0)).toBe(1);
    } finally {
      await Promise.all(writers.map((writer) => writer.end()));
    }
  });

  test('an instant with no weekly partition lands in the default partition, never rejected', async () => {
    const insert = (record: string, at: string) =>
      q<{ partition: string }>(
        `INSERT INTO kortix.audit_events
           (account_id, action, resource_type, authoritative_source, source_ledger, source_record_id,
            phase, occurred_at)
         VALUES ($1, 'test.partition.default', 'test', 'system', 'partition_default', $2, 'completed', $3)
         ON CONFLICT DO NOTHING RETURNING tableoid::regclass::text AS partition`,
        [ACCOUNT, record, at],
      );
    const old = iso(Date.now() - 200 * DAY);
    const future = iso(Date.now() + 400 * DAY);
    expect((await insert('old', old)).rows[0]?.partition).toBe('kortix.audit_events_default');
    expect((await insert('future', future)).rows[0]?.partition).toBe('kortix.audit_events_default');
    // A re-send of the same event still conflicts (same occurred_at, same partition).
    expect((await insert('old', old)).rowCount).toBe(0);
    // Readers see them through the same relation.
    const read = await q(`SELECT 1 FROM kortix.audit_events_all WHERE account_id = $1 AND action = 'test.partition.default'`, [ACCOUNT]);
    expect(read.rowCount).toBe(2);
  });

  test('creating a partition moves the default-partition rows of its week into it', async () => {
    const at = iso(Date.now() + 80 * DAY); // ~11 weeks ahead: past the 8 weeks the migration created
    const stray = await q<{ partition: string }>(
      `INSERT INTO kortix.audit_events(account_id, action, resource_type, authoritative_source, occurred_at)
       VALUES ($1, 'test.partition.move', 'test', 'system', $2)
       RETURNING tableoid::regclass::text AS partition`,
      [ACCOUNT, at],
    );
    expect(stray.rows[0]?.partition).toBe('kortix.audit_events_default');
    const created = await q<{ n: number }>(`SELECT kortix.audit_events_ensure_partitions('kortix.audit_events', current_date, 13) AS n`);
    expect(created.rows[0]?.n).toBeGreaterThan(0);
    const moved = await q<{ partition: string }>(
      `SELECT tableoid::regclass::text AS partition FROM kortix.audit_events WHERE account_id = $1 AND action = 'test.partition.move'`,
      [ACCOUNT],
    );
    expect(moved.rows).toHaveLength(1);
    expect(moved.rows[0]?.partition).toMatch(/^kortix\.audit_events_p\d{8}$/);
    // The move ran with the append-only guard lifted for itself only.
    expect((await q<{ v: string }>(`SELECT current_setting('kortix.audit_maintenance', true) AS v`)).rows[0]?.v).not.toBe('on');
  });

  test('audit_events_all returns the new partitions and the legacy table together, newest first', async () => {
    await q(
      `INSERT INTO kortix.audit_events_legacy(account_id, action, resource_type, authoritative_source, occurred_at)
       VALUES ($1, 'test.partition.legacy', 'test', 'system', $2)`,
      [ACCOUNT, iso(Date.now() - 200 * DAY)],
    );
    const hot = await q(
      `INSERT INTO kortix.audit_events(account_id, action, resource_type, authoritative_source)
       VALUES ($1, 'test.partition.hot', 'test', 'system') RETURNING event_id`,
      [ACCOUNT],
    );
    expect(hot.rowCount).toBe(1);
    const read = await q<{ action: string }>(
      `SELECT action FROM kortix.audit_events_all
        WHERE account_id = $1 AND action IN ('test.partition.legacy', 'test.partition.hot')
        ORDER BY occurred_at DESC, event_id DESC`,
      [ACCOUNT],
    );
    expect(read.rows.map((r) => r.action)).toEqual(['test.partition.hot', 'test.partition.legacy']);
    // The table alone holds only the new row.
    const table = await q(`SELECT 1 FROM kortix.audit_events WHERE account_id = $1 AND action = 'test.partition.legacy'`, [ACCOUNT]);
    expect(table.rowCount).toBe(0);
  });

  test('audit_events, audit_events_legacy and the view have identical columns', async () => {
    const columns = (relation: string) =>
      q(
        `SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull
           FROM pg_attribute a WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
          ORDER BY a.attnum`,
        [relation],
      ).then((r) => r.rows);
    const table = await columns('kortix.audit_events');
    expect(await columns('kortix.audit_events_legacy')).toEqual(table);
    expect((await columns('kortix.audit_events_all')).map((c) => [c.attname, c.type])).toEqual(
      table.map((c) => [c.attname, c.type]),
    );
  });

  test('stays append-only through the parent and through a partition', async () => {
    await expect(q(`UPDATE kortix.audit_events SET action = 'tampered' WHERE account_id = $1`, [ACCOUNT])).rejects.toMatchObject({ code: 'P0001' });
    await expect(q(`DELETE FROM kortix.audit_events WHERE account_id = $1`, [ACCOUNT])).rejects.toMatchObject({ code: 'P0001' });
    const partition = (await q<{ name: string }>(
      `SELECT tableoid::regclass::text AS name FROM kortix.audit_events WHERE account_id = $1 LIMIT 1`, [ACCOUNT])).rows[0]!.name;
    await expect(q(`UPDATE ${partition} SET action = 'tampered' WHERE account_id = $1`, [ACCOUNT])).rejects.toMatchObject({ code: 'P0001' });
  });

  test('queues webhook deliveries for rows in a partition, with no FK on event_id', async () => {
    const webhook = await q<{ webhook_id: string }>(
      `INSERT INTO kortix.audit_webhooks(account_id, url, secret, name, action_prefix)
       VALUES ($1, 'https://example.test/partitioned', 's', 'partitioned', 'test.partition.webhook')
       RETURNING webhook_id`,
      [ACCOUNT],
    );
    const event = await q<{ event_id: string }>(
      `INSERT INTO kortix.audit_events(account_id, action, resource_type, authoritative_source)
       VALUES ($1, 'test.partition.webhook', 'test', 'system') RETURNING event_id`,
      [ACCOUNT],
    );
    const delivery = await q(
      `SELECT 1 FROM kortix.audit_webhook_deliveries WHERE webhook_id = $1 AND event_id = $2`,
      [webhook.rows[0]!.webhook_id, event.rows[0]!.event_id],
    );
    expect(delivery.rowCount).toBe(1);
    const fk = await q(
      `SELECT 1 FROM pg_constraint
        WHERE conrelid = 'kortix.audit_webhook_deliveries'::regclass AND contype = 'f' AND confrelid::regclass::text LIKE '%audit_events%'`,
    );
    expect(fk.rowCount).toBe(0);
    await q(`DELETE FROM kortix.audit_webhook_deliveries WHERE webhook_id = $1`, [webhook.rows[0]!.webhook_id]);
  });

  test('audit_events_ensure_partitions is idempotent, extends the range, and tolerates concurrent callers', async () => {
    const count = async () =>
      (await q<{ n: number }>(`SELECT count(*)::int AS n FROM pg_inherits WHERE inhparent = 'kortix.audit_events'::regclass`)).rows[0]!.n;
    const before = await count();
    expect((await q<{ n: number }>(`SELECT kortix.audit_events_ensure_partitions('kortix.audit_events', current_date, 13) AS n`)).rows[0]!.n).toBe(0);
    const callers = await Promise.all(Array.from({ length: 3 }, connect));
    try {
      const created = await Promise.all(
        callers.map((c) => c.query<{ n: number }>(`SELECT kortix.audit_events_ensure_partitions('kortix.audit_events', current_date, 17) AS n`)),
      );
      // Four new weeks in total, whoever wins each one; nobody errors.
      expect(created.reduce((total, r) => total + r.rows[0]!.n, 0)).toBe(4);
    } finally {
      await Promise.all(callers.map((c) => c.end()));
    }
    expect(await count()).toBe(before + 4);
    // The new partitions inherit the triggers and the indexes.
    const newest = (await q<{ name: string }>(
      `SELECT c.relname AS name FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
        WHERE i.inhparent = 'kortix.audit_events'::regclass ORDER BY c.relname DESC LIMIT 1`)).rows[0]!.name;
    expect(newest).toMatch(/^audit_events_p\d{8}$/);
    const triggers = await q(`SELECT tgname FROM pg_trigger WHERE tgrelid = $1::regclass AND NOT tgisinternal ORDER BY 1`, [`kortix.${newest}`]);
    expect(triggers.rows.map((r) => r.tgname)).toEqual(['audit_events_append_only', 'audit_events_enqueue_webhooks', 'audit_events_prepare']);
    const indexes = await q<{ n: number }>(`SELECT count(*)::int AS n FROM pg_indexes WHERE tablename = $1`, [newest]);
    expect(indexes.rows[0]!.n).toBe(11); // 10 secondary + the primary key
  });

  test('the new table has the grants the legacy table has', async () => {
    const grants = (relation: string) =>
      q<{ grantee: string; privilege_type: string }>(
        `SELECT r.rolname AS grantee, a.privilege_type
           FROM pg_class c, aclexplode(c.relacl) a JOIN pg_roles r ON r.oid = a.grantee
          WHERE c.oid = $1::regclass ORDER BY 1, 2`,
        [relation],
      ).then((r) => r.rows);
    expect(await grants('kortix.audit_events')).toEqual(await grants('kortix.audit_events_legacy'));
    expect(await grants('kortix.audit_events_all')).toEqual(await grants('kortix.audit_events_legacy'));
  });

  test('plans: a time-bounded read prunes partitions, a newest-N read merges index scans', async () => {
    const plan = async (sql: string) => {
      const { rows } = await q<{ 'QUERY PLAN': unknown }>(`EXPLAIN (FORMAT JSON, COSTS OFF) ${sql}`);
      return JSON.stringify(rows[0]!['QUERY PLAN']);
    };
    // Literal instants, like the bind parameters of the API's queries: partition pruning at
    // plan time needs a constant (now() is only prunable at execution).
    const bounded = await plan(
      `SELECT * FROM kortix.audit_events_all WHERE account_id = '${ACCOUNT}' AND occurred_at >= '${iso(Date.now() - 2 * DAY)}' AND occurred_at < '${iso(Date.now())}' ORDER BY occurred_at DESC LIMIT 50`,
    );
    const scanned = new Set([...bounded.matchAll(/"Relation Name":"(audit_events_p\d+)"/g)].map((m) => m[1]));
    expect(scanned.size).toBeLessThanOrEqual(2);
    const newest = await plan(`SELECT event_id FROM kortix.audit_events_all ORDER BY occurred_at DESC LIMIT 10`);
    expect(newest).toContain('"Node Type":"Merge Append"');
    expect(newest).not.toContain('"Node Type":"Sort"');
    // The cursor lookup (event_id + a 1 ms window) reaches one partition.
    const at = Date.now() - DAY;
    const cursor = await plan(
      `SELECT occurred_at FROM kortix.audit_events_all WHERE event_id = '${crypto.randomUUID()}' AND account_id = '${ACCOUNT}'
         AND occurred_at >= '${iso(at)}' AND occurred_at < '${iso(at + 1)}'`,
    );
    expect(new Set([...cursor.matchAll(/"Relation Name":"(audit_events_p\d+)"/g)].map((m) => m[1])).size).toBeLessThanOrEqual(2);
  });
});
