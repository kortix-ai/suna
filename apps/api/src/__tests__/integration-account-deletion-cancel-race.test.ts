// Real-PostgreSQL race tests for `account_deletion_requests.status`.
//
// A cancel read the request `pending`, the worker claimed it (`processing`)
// in the gap, and the cancel then wrote `cancelled` by id over the claim. The
// irreversible deletion kept running and the user was told "Account deletion
// cancelled". The cancel is a compare-and-set on `pending` now: it loses to the
// claim and answers 409. Each test holds the claim in an open transaction,
// lets the cancel block on the row lock, then commits: the exact interleaving.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PgClient } from './helpers/pg-client';
import { interleave } from './helpers/interleave';

let admin: PgClient;
const created: string[] = [];

async function seedRequest(status: string): Promise<{ accountId: string; requestId: string }> {
  const accountId = crypto.randomUUID();
  const result = await admin.query(
    `INSERT INTO kortix.account_deletion_requests (account_id, user_id, scheduled_for, status)
     VALUES ($1, $1, now() - interval '1 hour', $2) RETURNING id`,
    [accountId, status],
  );
  created.push(result.rows[0].id);
  return { accountId, requestId: result.rows[0].id };
}

async function statusOf(requestId: string): Promise<string> {
  const result = await admin.query(`SELECT status FROM kortix.account_deletion_requests WHERE id = $1`, [requestId]);
  return result.rows[0].status;
}

describe('account deletion cancel vs worker claim (real PostgreSQL)', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    admin = new PgClient({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.connect();
  });

  afterAll(async () => {
    if (created.length > 0) {
      await admin.query(`DELETE FROM kortix.account_deletion_requests WHERE id = ANY($1::uuid[])`, [created]);
    }
    await admin.end();
  });

  test('a cancel that loses to the worker claim answers 409 and leaves the claim', async () => {
    const { accountId, requestId } = await seedRequest('pending');
    const { cancelAccountDeletion } = await import('../billing/services/account-deletion');
    const outcome = await interleave(
      (tx) =>
        tx.query(
          `UPDATE kortix.account_deletion_requests
           SET status = 'processing', processing_started_at = now() WHERE id = $1`,
          [requestId],
        ),
      () =>
        cancelAccountDeletion(accountId).then(
          () => ({ ok: true as const }),
          (err: { statusCode?: number }) => ({ ok: false as const, statusCode: err.statusCode }),
        ),
      'account_deletion_requests',
    );
    expect(outcome).toEqual({ ok: false, statusCode: 409 });
    expect(await statusOf(requestId)).toBe('processing');
  });

  test('a cancel after the worker claimed the request answers 409, not "no request"', async () => {
    const { accountId, requestId } = await seedRequest('processing');
    const { cancelAccountDeletion } = await import('../billing/services/account-deletion');
    const outcome = await cancelAccountDeletion(accountId).then(
      () => ({ ok: true as const }),
      (err: { statusCode?: number }) => ({ ok: false as const, statusCode: err.statusCode }),
    );
    expect(outcome).toEqual({ ok: false, statusCode: 409 });
    expect(await statusOf(requestId)).toBe('processing');
  });

  test('an uncontended cancel of a pending request cancels it', async () => {
    const { accountId, requestId } = await seedRequest('pending');
    const { cancelAccountDeletion } = await import('../billing/services/account-deletion');
    expect(await cancelAccountDeletion(accountId)).toEqual({ success: true, message: 'Account deletion cancelled' });
    expect(await statusOf(requestId)).toBe('cancelled');
  });

  test('completion never overwrites a cancelled request', async () => {
    const { requestId } = await seedRequest('cancelled');
    const { markDeletionCompleted } = await import('../billing/repositories/account-deletion');
    expect(await markDeletionCompleted(requestId)).toBe(false);
    expect(await statusOf(requestId)).toBe('cancelled');
  });
});
