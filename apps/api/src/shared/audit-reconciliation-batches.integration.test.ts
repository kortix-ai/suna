/**
 * Integration test (real PostgreSQL): a reconciliation pass is bounded by rows.
 *
 * Prod, 2026-10-03: an account with no mark scanned 80 days of history in one
 * statement. For accounts with ~300k usage and gateway rows that statement
 * outran the audit pool's 10 s statement_timeout on every visit, so the
 * account never got a mark and was never reconciled. A pass now covers at
 * most `batchRows` rows of each bulk ledger and records where it stopped.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PgClient } from '../__tests__/helpers/pg-client';
import { reconcileAuditEvents } from './audit-reconciliation';

const databaseUrl = process.env.TEST_DATABASE_URL;
const fixtureUrl = process.env.TEST_DATABASE_SUPERUSER_URL ?? databaseUrl;
const ACCOUNT = 'b8200000-0000-4000-a000-000000000001';

let client: PgClient;

/** A usage event `ageDays` old, inserted without the audit trigger. */
async function usageEvent(ageDays: number, audited = false) {
  if (!audited) await client.query(`SET session_replication_role = 'replica'`);
  try {
    const { rows } = await client.query<{ event_id: string }>(
      `INSERT INTO kortix.usage_events (account_id, provider, model, route, created_at)
       VALUES ($1, 'p', 'm', 'r', now() - $2::float8 * interval '1 day')
       RETURNING event_id`,
      [ACCOUNT, ageDays],
    );
    return rows[0].event_id;
  } finally {
    if (!audited) await client.query(`SET session_replication_role = 'origin'`);
  }
}

/** A provider event `ageDays` old, inserted without the audit trigger. */
async function providerEvent(ageDays: number) {
  await client.query(`SET session_replication_role = 'replica'`);
  try {
    await client.query(
      `INSERT INTO kortix.provider_events (provider, kind, outcome, account_id, created_at)
       VALUES ('daytona', 'start', 'ok', $1, now() - $2::float8 * interval '1 day')`,
      [ACCOUNT, ageDays],
    );
  } finally {
    await client.query(`SET session_replication_role = 'origin'`);
  }
}

const providerAudited = async () =>
  (
    await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM kortix.audit_events
        WHERE account_id = $1 AND source_ledger = 'provider_events'`,
      [ACCOUNT],
    )
  ).rows[0].n;

const auditRows = async () =>
  (
    await client.query<{ source_record_id: string; n: number }>(
      `SELECT source_record_id, count(*)::int AS n FROM kortix.audit_events
        WHERE account_id = $1 AND source_ledger = 'usage_events' GROUP BY 1`,
      [ACCOUNT],
    )
  ).rows;

const stateOf = async () =>
  (
    await client.query<{ checked_at: Date; full_scan_at: Date | string; in_progress: boolean }>(
      `SELECT checked_at, full_scan_at, full_scan_at = '-infinity' AS in_progress
         FROM kortix.audit_reconciliation_state WHERE account_id = $1`,
      [ACCOUNT],
    )
  ).rows[0];

describe.skipIf(!databaseUrl)('audit reconciliation is bounded by rows per pass', () => {
  beforeAll(async () => {
    client = new PgClient({ connectionString: fixtureUrl });
    await client.connect();
    await client.query(`INSERT INTO kortix.accounts(account_id, name) VALUES ($1, 'audit-batches')`, [ACCOUNT]);
  });

  afterAll(async () => {
    await client.query(`SET kortix.audit_maintenance = 'on'`);
    for (const t of ['audit_events', 'usage_events', 'provider_events', 'audit_reconciliation_state']) {
      await client.query(`DELETE FROM kortix.${t} WHERE account_id = $1`, [ACCOUNT]);
    }
    await client.query('DELETE FROM kortix.accounts WHERE account_id = $1', [ACCOUNT]);
    await client.end();
  });

  test('a full scan with no mark completes over several bounded passes, each row audited once', async () => {
    await usageEvent(100); // older than the 80-day hot window: never reconstructed
    const missing = [];
    for (const age of [70, 60, 50, 40, 30, 20]) missing.push(await usageEvent(age));
    const alreadyAudited = await usageEvent(10, true);
    missing.push(await usageEvent(0.01));
    // The bound counts every ledger together, not each one separately.
    for (const age of [65, 45, 25]) await providerEvent(age);

    // First pass: 2 rows, then it stops and records the scan as in progress.
    const first = await reconcileAuditEvents(ACCOUNT, 1_000, 2);
    expect(first).toMatchObject({ inserted: 2, complete: false });
    const mid = await stateOf();
    expect(mid.in_progress).toBe(true);

    let passes = 1;
    let complete = false;
    while (!complete && passes < 20) {
      const pass = await reconcileAuditEvents(ACCOUNT, 1_000, 2);
      expect(pass.inserted).toBeLessThanOrEqual(2);
      complete = pass.complete;
      passes += 1;
    }
    expect(complete).toBe(true);
    expect(passes).toBeGreaterThanOrEqual(6);
    expect(await providerAudited()).toBe(3);

    const rows = await auditRows();
    expect(rows.every((r) => r.n === 1)).toBe(true);
    expect(rows.map((r) => r.source_record_id).sort()).toEqual([...missing, alreadyAudited].sort());

    const done = await stateOf();
    expect(done.in_progress).toBe(false);
    expect((done.full_scan_at as Date).getTime()).toBe(done.checked_at.getTime());
  });

  test('an incremental pass over more rows than one batch also advances in bounded passes', async () => {
    const before = await stateOf();
    const fresh = [];
    for (let i = 0; i < 5; i += 1) fresh.push(await usageEvent(0));

    // The lookback re-reads the last hour, so the first batch of 2 can hold a
    // row the full scan already audited.
    const first = await reconcileAuditEvents(ACCOUNT, 1_000, 2);
    expect(first.complete).toBe(false);
    expect(first.inserted).toBeLessThanOrEqual(2);
    // An incremental pass never touches the full-scan time.
    expect(((await stateOf()).full_scan_at as Date).getTime()).toBe((before.full_scan_at as Date).getTime());

    let complete = false;
    for (let pass = 0; pass < 10 && !complete; pass += 1) {
      complete = (await reconcileAuditEvents(ACCOUNT, 1_000, 2)).complete;
    }
    expect(complete).toBe(true);
    const rows = await auditRows();
    expect(rows.every((r) => r.n === 1)).toBe(true);
    for (const id of fresh) expect(rows.some((r) => r.source_record_id === id)).toBe(true);
    expect(((await stateOf()).full_scan_at as Date).getTime()).toBe((before.full_scan_at as Date).getTime());
  });
});
