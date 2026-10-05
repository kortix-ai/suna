import { sql } from 'drizzle-orm';
import * as database from '../shared/db';

export function withDirectoryTransaction<T>(accountId: string, action: () => Promise<T>): Promise<T> {
  return database.withDbTransaction(async () => {
    await database.db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'directory:' + accountId}, 0))`);
    return action();
  });
}
