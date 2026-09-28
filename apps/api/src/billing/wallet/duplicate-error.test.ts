import { describe, expect, test } from 'bun:test';
import { isDuplicateCreditGrantError } from './duplicate-error';

// The first-row path through a real Drizzle wrapper (a replayed reset key
// raising `kortix_unique_stripe_event` on `cause`) is proven on PostgreSQL by
// tests/migration/wallet-ledger.test.ts "a replayed reset key is a silent no-op".

/** The exact shape a Drizzle insert failure has: the wrapper carries the
 *  statement and the parameters, and NOTHING else. Everything that identifies
 *  the fault is on `cause`. */
function drizzleFailure(cause: unknown): Error {
  return Object.assign(
    new Error(
      'Failed query: insert into "kortix"."credit_ledger" ("id", "account_id", "amount", ' +
        '"amount_precise", "balance_after", "balance_after_precise", "type", "description") ' +
        'values (default, $1, default, $2, default, $3, $4, $5) returning "id"\nparams: ' +
        '00000000-0000-4000-8000-000000000001,2,2,credit_reset,Free tier monthly credit reset: 2 credits',
    ),
    { cause },
  );
}

describe('isDuplicateCreditGrantError', () => {
  test('recognizes the unique idempotency-key index that refuses a concurrent same-key grant', () => {
    const pg = Object.assign(
      new Error('duplicate key value violates unique constraint "uniq_credit_ledger_idempotency_key"'),
      { code: '23505', constraint_name: 'uniq_credit_ledger_idempotency_key' },
    );
    expect(isDuplicateCreditGrantError(drizzleFailure(pg))).toBe(true);
  });

  test('a duplicate on some OTHER constraint is still a real failure', () => {
    // Only the grant-idempotency keys mean "already granted". Anything else
    // that collides is a defect and must keep paging.
    const pg = Object.assign(new Error('duplicate key value violates unique constraint "other"'), {
      code: '23505',
      constraint: 'some_other_unique',
    });
    expect(isDuplicateCreditGrantError(drizzleFailure(pg))).toBe(false);
  });

  test.each([
    ['a not-null violation', Object.assign(new Error('null value in column "type" violates not-null constraint'), { code: '23502' })],
    [
      // Names a grant marker but carries no duplicate signal: the marker alone
      // must not suppress a real failure.
      'a statement timeout while writing the idempotency-key index',
      Object.assign(new Error('canceling statement due to statement timeout'), {
        code: '57014',
        detail: 'while inserting index tuple in "uniq_credit_ledger_idempotency_key"',
      }),
    ],
  ])('a non-duplicate failure is never suppressed: %s', (_name, cause) => {
    expect(isDuplicateCreditGrantError(drizzleFailure(cause))).toBe(false);
  });

  test('a failure with no cause chain is never suppressed', () => {
    expect(isDuplicateCreditGrantError(new Error('connection terminated'))).toBe(false);
    expect(isDuplicateCreditGrantError(null)).toBe(false);
  });

  test('a self-referencing cause cannot loop', () => {
    const error: { message?: string; cause?: unknown } = { message: 'duplicate key' };
    error.cause = error;
    expect(isDuplicateCreditGrantError(error)).toBe(false);
  });
});
