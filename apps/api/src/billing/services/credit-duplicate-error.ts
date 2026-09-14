/**
 * Is this write failure the credit-grant idempotency key doing its job?
 *
 * A duplicate `stripe_event_id` (`kortix_unique_stripe_event`) or idempotency
 * key means the grant already landed and the database refused the second copy.
 * That is a NO-OP, not a fault, and it must never be logged as an error or
 * trigger a fallback that re-applies the grant.
 *
 * It has to read the whole error chain. A Drizzle failure's own `message` is
 * only `Failed query: insert into "kortix"."credit_ledger" … params: …`; the pg
 * detail, the constraint name and SQLSTATE 23505 hang off `cause`. A guard
 * written as `error.message.includes('duplicate key')` therefore never matches,
 * which is exactly how PROD 2026-09-04 → 2026-09-08 logged 1,118
 * `[Credits] Reset ledger entry failed` errors for one free account — one every
 * nine minutes, each a correctly-refused re-grant of the same
 * `free_tier_rotation_…` event.
 */

const CREDIT_GRANT_DUPLICATE_MARKERS = [
  'kortix_unique_stripe_event',
  'idx_kortix_credit_ledger_idempotency',
];

/** Every string an error chain carries, including `cause`. Cycle-safe. */
export function errorChainText(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const record = current as Record<string, unknown>;
    for (const key of ['name', 'message', 'code', 'constraint', 'constraint_name', 'detail']) {
      const value = record[key];
      if (typeof value === 'string' && value) parts.push(value);
    }
    current = record.cause;
  }

  if (parts.length === 0 && error != null) parts.push(String(error));
  return parts.join('\n');
}

export function isDuplicateCreditGrantError(error: unknown): boolean {
  const text = errorChainText(error).toLowerCase();
  const hasDuplicateSignal =
    text.includes('duplicate key') || text.includes('unique constraint') || text.includes('23505');
  return (
    hasDuplicateSignal && CREDIT_GRANT_DUPLICATE_MARKERS.some((marker) => text.includes(marker))
  );
}
