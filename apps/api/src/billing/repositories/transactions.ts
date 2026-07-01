import { Effect } from 'effect';
import { eq, desc, sql, and, gte, inArray } from 'drizzle-orm';
import { creditLedger, creditUsage, creditPurchases } from '@kortix/db';
import { DatabaseService } from '../../effect/services';
import { runEffectOrThrow } from '../../effect/http';

export async function insertLedgerEntry(data: typeof creditLedger.$inferInsert) {
  return runEffectOrThrow(Effect.gen(function* () {
    const { database } = yield* DatabaseService;
    const [row] = yield* Effect.tryPromise(() => database.insert(creditLedger).values(data).returning());
    return row;
  }));
}

export async function getTransactions(
  accountId: string,
  limit: number,
  offset: number,
  typeFilter?: string | string[],
) {
  return runEffectOrThrow(Effect.gen(function* () {
    const { database } = yield* DatabaseService;
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

    const rows = yield* Effect.tryPromise(() =>
      database
        .select()
        .from(creditLedger)
        .where(where)
        .orderBy(desc(creditLedger.createdAt))
        .limit(limit)
        .offset(offset),
    );

    const [countResult] = yield* Effect.tryPromise(() =>
      database
        .select({ count: sql<number>`count(*)` })
        .from(creditLedger)
        .where(where),
    );

    return { rows, total: Number(countResult?.count ?? 0) };
  }));
}

export async function getTransactionsSummary(accountId: string, days: number) {
  return runEffectOrThrow(Effect.gen(function* () {
    const { database } = yield* DatabaseService;
    const since = new Date(Date.now() - days * 86400000).toISOString();

    const [result] = yield* Effect.tryPromise(() =>
      database
        .select({
          totalCredits: sql<string>`coalesce(sum(case when amount > 0 then amount else 0 end), 0)`,
          totalDebits: sql<string>`coalesce(sum(case when amount < 0 then abs(amount) else 0 end), 0)`,
          count: sql<number>`count(*)`,
        })
        .from(creditLedger)
        .where(and(eq(creditLedger.accountId, accountId), gte(creditLedger.createdAt, since))),
    );

    return {
      totalCredits: Number(result?.totalCredits ?? 0),
      totalDebits: Number(result?.totalDebits ?? 0),
      count: Number(result?.count ?? 0),
    };
  }));
}

export async function getUsageRecords(
  accountId: string,
  limit: number,
  offset: number,
) {
  return runEffectOrThrow(Effect.gen(function* () {
    const { database } = yield* DatabaseService;
    const rows = yield* Effect.tryPromise(() =>
      database
        .select()
        .from(creditUsage)
        .where(eq(creditUsage.accountId, accountId))
        .orderBy(desc(creditUsage.createdAt))
        .limit(limit)
        .offset(offset),
    );

    const [countResult] = yield* Effect.tryPromise(() =>
      database
        .select({ count: sql<number>`count(*)` })
        .from(creditUsage)
        .where(eq(creditUsage.accountId, accountId)),
    );

    return { rows, total: Number(countResult?.count ?? 0) };
  }));
}

export async function insertPurchase(data: typeof creditPurchases.$inferInsert) {
  return runEffectOrThrow(Effect.gen(function* () {
    const { database } = yield* DatabaseService;
    const [row] = yield* Effect.tryPromise(() => database.insert(creditPurchases).values(data).returning());
    return row;
  }));
}

export async function updatePurchaseStatus(
  id: string,
  status: string,
  completedAt?: string,
) {
  return runEffectOrThrow(Effect.gen(function* () {
    const { database } = yield* DatabaseService;
    yield* Effect.tryPromise(() =>
      database
        .update(creditPurchases)
        .set({ status, completedAt: completedAt ?? null })
        .where(eq(creditPurchases.id, id)),
    );
  }));
}

export async function getPurchaseByPaymentIntent(stripePaymentIntentId: string) {
  return runEffectOrThrow(Effect.gen(function* () {
    const { database } = yield* DatabaseService;
    const [row] = yield* Effect.tryPromise(() =>
      database
        .select()
        .from(creditPurchases)
        .where(eq(creditPurchases.stripePaymentIntentId, stripePaymentIntentId))
        .limit(1),
    );

    return row ?? null;
  }));
}
