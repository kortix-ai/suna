// Billing v2 — usage breakdown by ledger category.
//
// The wallet is fungible (one $balance), but every debit carries a granular
// kind. Aggregating by that kind for the current billing period gives the UI
// the "you spent $X compute, $Y LLM" breakdown without ever partitioning the
// wallet itself.
//
// WHERE THE KIND ACTUALLY LIVES: every debit is written by the atomic_use_credits
// RPC (credits.ts -> deductCredits), which stores a flat `type` of 'usage' and
// puts the granular kind in metadata->>'ledger_type'. That has been true since
// the baseline migration, so credit_ledger.type has NEVER held 'compute_debit'
// or 'llm_debit' for an RPC-written row — filtering on `type` alone matched
// nothing and reported $0 compute / $0 LLM for every account. Same family of bug
// as the dead credit_accounts.lifetime_* columns (fixed in 2a3bd18e9): a
// denormalized read that disagreed with the ledger.
//
// Read from the authoritative source and fall back to `type` so a row written
// directly through Drizzle (repositories/transactions.ts) with a granular type
// and no metadata still classifies.

import { creditLedger } from '@kortix/db';
import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { db } from '../../shared/db';

const COMPUTE_DEBIT_KINDS = ['compute_debit'] as const;
const LLM_DEBIT_KINDS = ['llm_debit', 'token_deduction', 'token_overage'] as const;
/**
 * Debits that are neither compute nor LLM.
 *
 * `usage` is what the router writes for a Kortix tool call — deliberately not
 * `llm_debit` (router/services/billing.ts:68). It was in neither list, and the
 * query filters on `inArray(LEDGER_KIND, DEBIT_KINDS)`, so this money was not
 * merely uncategorised: it was excluded from the result set entirely and
 * vanished from the total. On the production Kortix account that is 10,859 rows.
 *
 * `admin_debit` is a manual adjustment. It is real money leaving the wallet, so
 * it belongs in the total; calling it compute or LLM would be a lie.
 */
const OTHER_DEBIT_KINDS = ['usage', 'admin_debit'] as const;
const DEBIT_KINDS: string[] = [
  ...COMPUTE_DEBIT_KINDS,
  ...LLM_DEBIT_KINDS,
  ...OTHER_DEBIT_KINDS,
];

// metadata->>'ledger_type' first, credit_ledger.type second. NULLIF guards the
// rows whose metadata is present but carries an empty ledger_type.
const LEDGER_KIND = sql<string>`COALESCE(NULLIF(${creditLedger.metadata} ->> 'ledger_type', ''), ${creditLedger.type})`;

export interface UsageBreakdown {
  compute_usd: number;
  llm_usd: number;
  /** Debits that are neither compute nor LLM — tool calls, manual adjustments. */
  other_usd: number;
  total_usd: number;
  period_start: string | null;
  period_end: string | null;
}

export function classifyLedgerKind(kind: string | null): 'compute' | 'llm' | 'other' | null {
  if (!kind) return null;
  if ((COMPUTE_DEBIT_KINDS as readonly string[]).includes(kind)) return 'compute';
  if ((LLM_DEBIT_KINDS as readonly string[]).includes(kind)) return 'llm';
  if ((OTHER_DEBIT_KINDS as readonly string[]).includes(kind)) return 'other';
  return null;
}

/**
 * The start of the CURRENT billing period, from a fixed monthly anchor.
 *
 * `credit_accounts.billing_cycle_anchor` is Stripe's anchor: the instant the
 * subscription started, and it never moves. Passing it straight through as
 * "period start" meant the window never reset — "Spend this period" quietly
 * accumulated LIFETIME spend under a this-period label. On the production
 * Kortix account the anchor is 2026-06-07, two months stale.
 *
 * Roll it forward by whole months to the most recent occurrence at or before
 * `now`. Day-of-month is clamped, so a 31st anchor lands on the 28th/30th in
 * shorter months and returns to the 31st afterwards — same rule Stripe uses.
 */
export function currentPeriodStart(anchorIso: string | null, now: Date = new Date()): string | null {
  if (!anchorIso) return null;
  const anchor = new Date(anchorIso);
  if (Number.isNaN(anchor.getTime())) return null;
  if (anchor >= now) return anchor.toISOString();

  const months =
    (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
    (now.getUTCMonth() - anchor.getUTCMonth());

  const at = (monthOffset: number): Date => {
    const y = anchor.getUTCFullYear();
    const m = anchor.getUTCMonth() + monthOffset;
    // Day 0 of the following month = last day of the target month.
    const daysInTarget = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return new Date(
      Date.UTC(
        y,
        m,
        Math.min(anchor.getUTCDate(), daysInTarget),
        anchor.getUTCHours(),
        anchor.getUTCMinutes(),
        anchor.getUTCSeconds(),
        anchor.getUTCMilliseconds(),
      ),
    );
  };

  // `months` can overshoot by one when the day-of-month has not arrived yet.
  const candidate = at(months);
  return (candidate <= now ? candidate : at(months - 1)).toISOString();
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
  const since = periodStart ? new Date(periodStart) : new Date(Date.now() - 30 * 86400 * 1000);
  const sinceIso = since.toISOString();

  // Single query: group by the resolved ledger kind, sum the absolute value of
  // negative amounts (debits are stored as negative numbers in our ledger
  // convention). Use COALESCE so the row exists even when there are no debits
  // yet. `creditLedger.amount` is the precise (20,10) column, not the rounded
  // legacy one.
  const rows = await db
    .select({
      kind: LEDGER_KIND,
      total: sql<string>`COALESCE(SUM(ABS(${creditLedger.amount})), 0)`,
    })
    .from(creditLedger)
    .where(
      and(
        eq(creditLedger.accountId, accountId),
        gte(creditLedger.createdAt, sinceIso),
        // Only debit-shaped kinds (positive grants and refunds are excluded).
        inArray(LEDGER_KIND, DEBIT_KINDS),
        // And only actual debits. The comment below always claimed "negative
        // amounts" but nothing enforced it — harmless while every listed kind
        // was strictly negative, unsafe now that `admin_debit` is counted, since
        // a positive manual adjustment would otherwise inflate reported spend.
        lt(creditLedger.amount, '0'),
      ),
    )
    .groupBy(LEDGER_KIND);

  let compute = 0;
  let llm = 0;
  let other = 0;
  for (const row of rows) {
    const amt = Number(row.total) || 0;
    const category = classifyLedgerKind(row.kind);
    if (category === 'compute') {
      compute += amt;
    } else if (category === 'llm') {
      llm += amt;
    } else if (category === 'other') {
      other += amt;
    }
  }

  return {
    compute_usd: compute,
    llm_usd: llm,
    other_usd: other,
    total_usd: compute + llm + other,
    period_start: sinceIso,
    period_end: null, // open period — current billing cycle hasn't closed yet
  };
}
