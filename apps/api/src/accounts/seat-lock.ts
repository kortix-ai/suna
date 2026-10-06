import { sql } from 'drizzle-orm';
// A namespace import: ~190 unit suites mock shared/db without
// withDbTransaction, and a named import fails at link time in every one that
// reaches this module (accounts/invites.ts).
import * as database from '../shared/db';

/**
 * Serialize "count the seats, then add the member" per account. Without it,
 * N concurrent accepts of a 2-seat trial all read `members < limit` and all
 * insert. `fn` runs in one transaction that holds a per-account advisory lock
 * until commit; the seat check and the membership insert both go inside `fn`.
 */
export function withAccountSeatLock<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
  return database.withDbTransaction(async () => {
    await database.db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`account-seats:${accountId}`}, 0))`);
    return fn();
  });
}
