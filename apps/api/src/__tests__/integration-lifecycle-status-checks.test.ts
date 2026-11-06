/**
 * Migration 20261106140140429_lifecycle_status_checks (real PostgreSQL,
 * migrated from empty): nine lifecycle text columns that accepted any string
 * carry a NOT VALID CHECK. A write of an unknown value fails with 23514; a
 * value only old rows hold (kept so an old row stays updatable) passes.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PgClient } from './helpers/pg-client';

const ACCOUNT_ID = '00000000-0000-4000-a000-0000000f8c01';
const CHECKS = [
  'account_deletion_requests_status_check',
  'chat_thread_participants_status_check',
  'cli_device_grants_status_check',
  'credit_accounts_payment_status_check',
  'credit_accounts_trial_status_check',
  'project_git_connections_status_check',
  'project_snapshot_archives_status_check',
  'project_trigger_executions_run_status_check',
  'project_trigger_executions_status_check',
];

let pg: PgClient;

async function sqlState(text: string, values: unknown[] = []): Promise<string | null> {
  try {
    await pg.query(text, values);
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? 'unknown';
  }
}

beforeAll(async () => {
  pg = new PgClient({ connectionString: process.env.TEST_DATABASE_URL });
  await pg.connect();
  await pg.query(`INSERT INTO kortix.accounts (account_id, name) VALUES ($1, 'status checks') ON CONFLICT DO NOTHING`, [ACCOUNT_ID]);
});

afterAll(async () => {
  await pg.query(`DELETE FROM kortix.credit_accounts WHERE account_id = $1`, [ACCOUNT_ID]);
  await pg.query(`DELETE FROM kortix.cli_device_grants WHERE device_code_hash LIKE 'status-check-%'`);
  await pg.query(`DELETE FROM kortix.accounts WHERE account_id = $1`, [ACCOUNT_ID]);
  await pg.end();
});

describe('lifecycle status CHECK constraints', () => {
  test('every constraint exists and is NOT VALID', async () => {
    const rows = await pg.query(
      `SELECT conname, convalidated FROM pg_constraint WHERE contype = 'c' AND conname = ANY($1) ORDER BY conname`,
      [CHECKS],
    );
    expect(rows.rows).toEqual(CHECKS.map((conname) => ({ conname, convalidated: false })));
  });

  test('an unknown value is refused with 23514', async () => {
    expect(
      await sqlState(
        `INSERT INTO kortix.cli_device_grants (device_code_hash, user_code, expires_at, status) VALUES ('status-check-1', 'SC-1', now(), 'bogus')`,
      ),
    ).toBe('23514');
    expect(
      await sqlState(`INSERT INTO kortix.credit_accounts (account_id, payment_status) VALUES ($1, 'trialing')`, [ACCOUNT_ID]),
    ).toBe('23514');
  });

  test('every value a writer or a live row holds is accepted', async () => {
    expect(
      await sqlState(
        `INSERT INTO kortix.cli_device_grants (device_code_hash, user_code, expires_at, status) VALUES ('status-check-2', 'SC-2', now(), 'consumed')`,
      ),
    ).toBeNull();
    expect(
      await sqlState(
        `INSERT INTO kortix.credit_accounts (account_id, payment_status, trial_status) VALUES ($1, 'pending', 'converted')`,
        [ACCOUNT_ID],
      ),
    ).toBeNull();
    for (const status of ['active', 'cancelling', 'past_due', 'failed', 'deleted']) {
      expect(await sqlState(`UPDATE kortix.credit_accounts SET payment_status = $2 WHERE account_id = $1`, [ACCOUNT_ID, status])).toBeNull();
    }
  });
});
