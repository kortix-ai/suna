// Billing v2 — usage breakdown by ledger category.
//
// The wallet is fungible (one $balance), but every debit is tagged in
// credit_ledger.type. Aggregating by type for the current billing period
// gives the UI the "you spent $X compute, $Y LLM" breakdown without ever
// partitioning the wallet itself.

import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { creditLedger } from '@kortix/db';
import { db } from '../../shared/db';

const COMPUTE_DEBIT_TYPES = ['compute_debit'] as const;
const LLM_DEBIT_TYPES = ['llm_debit', 'token_deduction', 'token_overage'] as const;

interface UsageBreakdown {
  compute_usd: number;
  llm_usd: number;
  total_usd: number;
  period_start: string | null;
  period_end: string | null;
}

/**
 * Sum debits since the current period started, grouped by category.
 * `periodStart` is normally credit_accounts.billing_cycle_anchor; if absent
 * we fall back to "last 30 days" so the UI still has a number to render.
 */
export async function getUsageBreakdownThisPeriod(
  accountId: string,
  periodStart: string | null,
): Promise<UsageBreakdown> {
  const since = periodStart
    ? new Date(periodStart)
    : new Date(Date.now() - 30 * 86400 * 1000);
  const sinceIso = since.toISOString();

  // Single query: group by ledger type, sum the absolute value of negative
  // amounts (debits are stored as negative numbers in our ledger convention).
  // Use COALESCE so the row exists even when there are no debits yet.
  const rows = await db
    .select({
      type: creditLedger.type,
      total: sql<string>`COALESCE(SUM(ABS(${creditLedger.amount})), 0)`,
    })
    .from(creditLedger)
    .where(
      and(
        eq(creditLedger.accountId, accountId),
        gte(creditLedger.createdAt, sinceIso),
        // Only debit-shaped types (positive grants are excluded).
        inArray(creditLedger.type, [...COMPUTE_DEBIT_TYPES, ...LLM_DEBIT_TYPES]),
      ),
    )
    .groupBy(creditLedger.type);

  let compute = 0;
  let llm = 0;
  for (const row of rows) {
    const amt = Number(row.total) || 0;
    if ((COMPUTE_DEBIT_TYPES as readonly string[]).includes(row.type)) {
      compute += amt;
    } else if ((LLM_DEBIT_TYPES as readonly string[]).includes(row.type)) {
      llm += amt;
    }
  }

  return {
    compute_usd: compute,
    llm_usd: llm,
    total_usd: compute + llm,
    period_start: sinceIso,
    period_end: null, // open period — current billing cycle hasn't closed yet
  };
}
