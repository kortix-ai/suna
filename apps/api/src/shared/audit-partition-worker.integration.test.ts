import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import pg from 'pg';
import { ensureAuditPartitions } from './audit-partition-worker';

const databaseUrl = process.env.TEST_DATABASE_URL;
const ACCOUNT = 'b9100000-0000-4000-a000-000000000001';

let client: pg.Client | null = null;
const q = <T extends pg.QueryResultRow = Record<string, unknown>>(
  text: string,
  values?: unknown[],
) => client!.query<T>(text, values);

/** Monday 00:00 UTC of the week of `moment`. */
function weekStart(moment: Date): Date {
  const day = new Date(moment);
  day.setUTCHours(0, 0, 0, 0);
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day;
}

/**
 * Horizon weeks [week(now) .. week(now) + weeksAhead] that have no partition,
 * with the same name predicate the SQL function itself applies. The migration
 * pre-creates its own apply week through +8, so the count depends on the
 * database's age, never on the calendar alone: a per-suite template ages one
 * week per Monday after its build.
 */
async function missingHorizonWeeks(weeksAhead: number): Promise<number> {
  const from = weekStart(new Date());
  const to = new Date(from);
  to.setUTCDate(to.getUTCDate() + weeksAhead * 7);
  const { rows } = await q<{ missing: number }>(
    `SELECT count(*)::int AS missing
       FROM generate_series($1::date, $2::date, interval '7 days') AS w(week_start)
      WHERE to_regclass('kortix.audit_events_p' || to_char(w.week_start, 'YYYYMMDD')) IS NULL`,
    [from.toISOString().slice(0, 10), to.toISOString().slice(0, 10)],
  );
  const row = rows[0];
  if (!row) throw new Error('the missing-weeks query returned no row');
  return row.missing;
}

describe.skipIf(!databaseUrl)('audit partition maintenance — migrated PostgreSQL', () => {
  beforeAll(async () => {
    client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
  });

  afterAll(async () => {
    if (!client) return;
    await client.query("SET kortix.audit_maintenance = 'on'");
    await client.query('DELETE FROM kortix.audit_events WHERE account_id = $1', [ACCOUNT]);
    await client.end();
  });

  test('creates exactly the horizon weeks the catalog is missing, and is then a no-op', async () => {
    const missing = await missingHorizonWeeks(8);
    const quiet = await ensureAuditPartitions();
    expect(quiet).toEqual({ created: missing, defaultPartitionHasRows: false });
    expect((await ensureAuditPartitions()).created).toBe(0);
    // 12 weeks ahead stands in for "four weeks later": whatever the template's
    // age, the call creates exactly the missing weeks and is then a no-op.
    const missing12 = await missingHorizonWeeks(12);
    const later = await ensureAuditPartitions(12);
    expect(later.created).toBe(missing12);
    expect((await ensureAuditPartitions(12)).created).toBe(0);
  });

  test('re-creates exactly the newest horizon week after a Monday rollover', async () => {
    // The calendar rolled one Monday past the pre-created range: the newest
    // horizon week is the partition a cached per-suite template has lost. Drop
    // it on any UTC day and expect exactly it back on the next tick.
    await ensureAuditPartitions();
    const rolled = weekStart(new Date());
    rolled.setUTCDate(rolled.getUTCDate() + 8 * 7);
    const name = `audit_events_p${rolled.toISOString().slice(0, 10).replaceAll('-', '')}`;
    await q(`ALTER TABLE kortix.audit_events DETACH PARTITION kortix.${name}`);
    await q(`DROP TABLE kortix.${name}`);
    expect(await missingHorizonWeeks(8)).toBe(1);
    expect((await ensureAuditPartitions()).created).toBe(1);
    expect(await missingHorizonWeeks(8)).toBe(0);
  });

  test('reports rows stranded in the default partition', async () => {
    // Far enough ahead that no weekly partition exists yet, so the row lands in the default one.
    await q(
      "INSERT INTO kortix.audit_events(account_id, action, resource_type, authoritative_source, occurred_at) VALUES ($1, 'test.partition.stray', 'test', 'system', now() + interval '400 days')",
      [ACCOUNT],
    );
    expect((await ensureAuditPartitions()).defaultPartitionHasRows).toBe(true);
  });
});
