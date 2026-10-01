/**
 * Integration test (real PostgreSQL): audit reconciliation is incremental.
 *
 * The worker used to anti-join an account's full history against
 * `kortix.audit_events` (142M rows in prod) on every visit, for every
 * account, on every replica, forever. Now a per-account high-water mark
 * (`kortix.audit_reconciliation_state`) limits a pass to rows newer than the
 * last complete pass minus a lookback, and re-verifies the whole history
 * only once per FULL_RESCAN interval.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import pg from 'pg';
import { reconcileAuditEvents } from './audit-reconciliation';
import { runAuditReconciliationPage } from './audit-reconciliation-worker';

const databaseUrl = process.env.TEST_DATABASE_URL;
const fixtureUrl = process.env.TEST_DATABASE_SUPERUSER_URL ?? databaseUrl;
const ACCOUNT = 'b8100000-0000-4000-a000-000000000001';
const OTHER = 'b8100000-0000-4000-a000-000000000002';

let client: pg.Client;

async function providerEvent(accountId: string, kind: string, ageDays = 0) {
  await client.query(`SET session_replication_role = 'replica'`);
  try {
    await client.query(
      `INSERT INTO kortix.provider_events (provider, kind, outcome, account_id, created_at)
       VALUES ('daytona', $2, 'ok', $1, now() - make_interval(days => $3))`,
      [accountId, kind, ageDays],
    );
  } finally {
    await client.query(`SET session_replication_role = 'origin'`);
  }
}

const audited = async (accountId: string) =>
  (
    await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM kortix.audit_events
        WHERE account_id = $1 AND source_ledger = 'provider_events'`,
      [accountId],
    )
  ).rows[0].n;

const stateOf = async (accountId: string) =>
  (
    await client.query<{ checked_at: Date; full_scan_at: Date }>(
      'SELECT checked_at, full_scan_at FROM kortix.audit_reconciliation_state WHERE account_id = $1',
      [accountId],
    )
  ).rows[0];

describe.skipIf(!databaseUrl)('audit reconciliation is incremental', () => {
  beforeAll(async () => {
    client = new pg.Client({ connectionString: fixtureUrl });
    await client.connect();
    await client.query('DELETE FROM kortix.provider_events WHERE account_id = ANY($1::uuid[])', [
      [ACCOUNT, OTHER],
    ]);
    await client.query(
      `INSERT INTO kortix.accounts(account_id, name) VALUES ($1, 'audit-incr'), ($2, 'audit-incr-2')`,
      [ACCOUNT, OTHER],
    );
  });

  afterAll(async () => {
    await client.query(`SET kortix.audit_maintenance = 'on'`);
    for (const t of ['audit_events', 'provider_events', 'audit_reconciliation_state']) {
      await client.query(`DELETE FROM kortix.${t} WHERE account_id = ANY($1::uuid[])`, [
        [ACCOUNT, OTHER],
      ]);
    }
    await client.query('DELETE FROM kortix.accounts WHERE account_id = ANY($1::uuid[])', [
      [ACCOUNT, OTHER],
    ]);
    await client.end();
  });

  test('first pass scans the whole history, records the mark, and a crash mid-run loses nothing', async () => {
    await providerEvent(ACCOUNT, 'ancient', 400);
    await providerEvent(ACCOUNT, 'old', 30);
    await providerEvent(ACCOUNT, 'new');

    // A page smaller than the backlog is a "crash" point: it reports
    // incomplete and must NOT advance the mark.
    const partial = await reconcileAuditEvents(ACCOUNT, 1);
    expect(partial).toMatchObject({ inserted: 1, complete: false });
    expect(await stateOf(ACCOUNT)).toBeUndefined();

    // Resume: the next calls start from the same (absent) mark and finish.
    const rest = await reconcileAuditEvents(ACCOUNT, 10);
    expect(rest).toMatchObject({ inserted: 2, complete: true });
    expect(await audited(ACCOUNT)).toBe(3);
    const state = await stateOf(ACCOUNT);
    expect(state.checked_at).toBeInstanceOf(Date);
    expect(state.full_scan_at.getTime()).toBe(state.checked_at.getTime());
  });

  test('a later pass reconciles new rows and does not rescan reconciled history', async () => {
    const before = await stateOf(ACCOUNT);
    await providerEvent(ACCOUNT, 'fresh');
    // A row outside the lookback with no audit event. A full scan would
    // insert it; an incremental pass must not even look at it.
    await providerEvent(ACCOUNT, 'unreconciled-old', 90);

    const result = await reconcileAuditEvents(ACCOUNT, 10);
    expect(result).toEqual({ inserted: 1, complete: true, by_source: { provider_events: 1 } });
    expect(await audited(ACCOUNT)).toBe(4);

    const after = await stateOf(ACCOUNT);
    expect(after.checked_at.getTime()).toBeGreaterThan(before.checked_at.getTime());
    expect(after.full_scan_at.getTime()).toBe(before.full_scan_at.getTime());
  });

  test('the weekly full rescan re-verifies old history', async () => {
    await client.query(
      `UPDATE kortix.audit_reconciliation_state SET full_scan_at = now() - interval '8 days'
        WHERE account_id = $1`,
      [ACCOUNT],
    );
    const result = await reconcileAuditEvents(ACCOUNT, 10);
    expect(result).toEqual({ inserted: 1, complete: true, by_source: { provider_events: 1 } });
    expect(await audited(ACCOUNT)).toBe(5);
    const state = await stateOf(ACCOUNT);
    expect(state.full_scan_at.getTime()).toBe(state.checked_at.getTime());
  });

  test('the worker skips an account checked within the recheck interval', async () => {
    // ACCOUNT has a fresh mark from the passes above, so OTHER is the next due
    // account. Start the scan just before ACCOUNT, or before OTHER if it sorts first.
    const first = ACCOUNT < OTHER ? ACCOUNT : OTHER;
    const before = (
      await client.query<{ account_id: string }>(
        'SELECT account_id FROM kortix.accounts WHERE account_id < $1 ORDER BY account_id DESC LIMIT 1',
        [first],
      )
    ).rows[0]?.account_id ?? null;
    const page = await runAuditReconciliationPage(before);
    expect(page.accountId).toBe(OTHER);
    expect((await stateOf(OTHER)).checked_at).toBeInstanceOf(Date);

    await client.query(
      `UPDATE kortix.audit_reconciliation_state SET checked_at = now() - interval '7 hours'
        WHERE account_id = $1`,
      [ACCOUNT],
    );
    const due = await runAuditReconciliationPage(before);
    expect(due.accountId).toBe(ACCOUNT);
  });
});
