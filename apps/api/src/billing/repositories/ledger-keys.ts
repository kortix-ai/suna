import { creditLedger } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../../shared/db';

/** Did a wallet write under this request key commit? Answers an ambiguous failure (a lost response). */
export async function ledgerRequestKeyExists(requestKey: string): Promise<boolean> {
  const [row] = await db
    .select({ id: creditLedger.id })
    .from(creditLedger)
    .where(eq(creditLedger.idempotencyKey, requestKey))
    .limit(1);
  return Boolean(row);
}
