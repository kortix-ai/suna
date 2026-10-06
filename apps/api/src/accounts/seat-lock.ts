import { sql } from 'drizzle-orm';
import { db, withDbTransaction } from '../shared/db';

/**
 * Serialize "count the seats, then add the member" per account. Without it,
 * N concurrent accepts of a 2-seat trial all read `members < limit` and all
 * insert. `fn` runs in one transaction that holds a per-account advisory lock
 * until commit; the seat check and the membership insert both go inside `fn`.
 */
export function withAccountSeatLock<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
  return withDbTransaction(async () => {
    await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`account-seats:${accountId}`}, 0))`);
    return fn();
  });
}
