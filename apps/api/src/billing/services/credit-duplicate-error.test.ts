import { describe, expect, test } from 'bun:test';
import { errorChainText, isDuplicateCreditGrantError } from './credit-duplicate-error';

/** The exact shape a Drizzle insert failure has: the wrapper carries the
 *  statement and the parameters, and NOTHING else. Everything that identifies
 *  the fault is on `cause`. */
function drizzleFailure(cause: unknown): Error {
  return Object.assign(
    new Error(
      'Failed query: insert into "kortix"."credit_ledger" ("id", "account_id", "amount", ' +
        '"amount_precise", "balance_after", "balance_after_precise", "type", "description") ' +
        'values (default, $1, default, $2, default, $3, $4, $5) returning "id"\nparams: ' +
        '3049dd09-ea07-4b76-8096-a7d01b65c25b,2,2,credit_reset,Free tier monthly credit reset: 2 credits',
    ),
    { cause },
  );
}

describe('isDuplicateCreditGrantError', () => {
  test('recognizes the duplicate through a Drizzle wrapper', () => {
    // The regression: the old guard read `error.message` only, which never
    // contains the constraint — so a correctly-refused re-grant was logged as
    // an error every nine minutes for four days in prod.
    const pg = Object.assign(
      new Error('duplicate key value violates unique constraint "kortix_unique_stripe_event"'),
      { code: '23505', constraint: 'kortix_unique_stripe_event' },
    );
    expect(isDuplicateCreditGrantError(drizzleFailure(pg))).toBe(true);
  });

  test('the naive message-only check would have missed it', () => {
    const pg = Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
      constraint: 'kortix_unique_stripe_event',
    });
    const wrapper = drizzleFailure(pg);
    expect(wrapper.message.includes('duplicate key')).toBe(false);
    expect(isDuplicateCreditGrantError(wrapper)).toBe(true);
  });

  test('recognizes the idempotency-key index too', () => {
    const pg = Object.assign(new Error('duplicate key value'), {
      code: '23505',
      constraint: 'idx_kortix_credit_ledger_idempotency',
    });
    expect(isDuplicateCreditGrantError(drizzleFailure(pg))).toBe(true);
  });

  test('a duplicate on some OTHER constraint is still a real failure', () => {
    // Only the two grant-idempotency keys mean "already granted". Anything else
    // that collides is a defect and must keep paging.
    const pg = Object.assign(new Error('duplicate key value violates unique constraint "other"'), {
      code: '23505',
      constraint: 'some_other_unique',
    });
    expect(isDuplicateCreditGrantError(drizzleFailure(pg))).toBe(false);
  });

  test('a non-duplicate failure is never suppressed', () => {
    const pg = Object.assign(new Error('null value in column "type" violates not-null constraint'), {
      code: '23502',
    });
    expect(isDuplicateCreditGrantError(drizzleFailure(pg))).toBe(false);
    expect(isDuplicateCreditGrantError(new Error('connection terminated'))).toBe(false);
    expect(isDuplicateCreditGrantError(null)).toBe(false);
  });

  test('a self-referencing cause cannot loop', () => {
    const error: { message?: string; cause?: unknown } = { message: 'x' };
    error.cause = error;
    expect(errorChainText(error)).toBe('x');
  });
});
