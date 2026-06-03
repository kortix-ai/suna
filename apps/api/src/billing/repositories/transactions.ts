import { eq, desc, sql, and, inArray } from 'drizzle-orm';
import { creditLedger, creditPurchases } from '@kortix/db';
import { db } from '../../shared/db';

export async function insertLedgerEntry(data: typeof creditLedger.$inferInsert) {
  const [row] = await db.insert(creditLedger).values(data).returning();
  return row;
}

export async function getTransactions(
  accountId: string,
  limit: number,
  offset: number,
  typeFilter?: string | string[],
) {
  const conditions = [eq(creditLedger.accountId, accountId)];

  const typeFilters = Array.isArray(typeFilter)
    ? typeFilter.filter(Boolean)
    : typeFilter
      ? [typeFilter]
      : [];

  if (typeFilters.length === 1) {
    conditions.push(eq(creditLedger.type, typeFilters[0]!));
  } else if (typeFilters.length > 1) {
    conditions.push(inArray(creditLedger.type, typeFilters));
  }

  const where = conditions.length === 1 ? conditions[0] : and(...conditions)!;

  const rows = await db
    .select()
    .from(creditLedger)
    .where(where)
    .orderBy(desc(creditLedger.createdAt))
    .limit(limit)
    .offset(offset);

  const [countResult] = await db
    .select({ count: sql<number>`count(*)` })
    .from(creditLedger)
    .where(where);

  return { rows, total: Number(countResult?.count ?? 0) };
}

export async function insertPurchase(data: typeof creditPurchases.$inferInsert) {
  const [row] = await db.insert(creditPurchases).values(data).returning();
  return row;
}

export async function updatePurchaseStatus(
  id: string,
  status: string,
  completedAt?: string,
) {
  await db
    .update(creditPurchases)
    .set({ status, completedAt: completedAt ?? null })
    .where(eq(creditPurchases.id, id));
}

export async function getPurchaseByPaymentIntent(stripePaymentIntentId: string) {
  const [row] = await db
    .select()
    .from(creditPurchases)
    .where(eq(creditPurchases.stripePaymentIntentId, stripePaymentIntentId))
    .limit(1);

  return row ?? null;
}
