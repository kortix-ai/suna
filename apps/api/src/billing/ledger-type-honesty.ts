// A credit_ledger row must not say two different things about the same money.
//
// THE INCIDENT (2026-07-30). A hand-run entitlement reconciliation wrote 1,609
// clawback rows with `type = 'usage'` while stamping
// `metadata->>'ledger_type' = 'admin_debit'`. The row therefore claimed to be
// customer usage in one column and an operator correction in the other. A
// -$5,239 admin correction on one account rendered as a $5.5k usage spike during
// a fraud investigation, and every aggregation that groups on
// credit_ledger.type counted an admin correction as revenue-bearing usage.
// The repair is packages/db/migrations/20260807202629374_ledger_type_backfill_reconcile_20260730.sql;
// this module is what stops it happening again.
//
// WHAT "HONEST" MEANS HERE. `type` and `metadata->>'ledger_type'` are NOT
// duplicates — `ledger_type` is deliberately the finer grain. atomic_use_credits
// writes `type = 'usage'` for every debit it makes and puts the granular kind
// ('llm_debit', 'compute_debit', ...) in metadata. Those rows are honest: the
// granular kind is a SUB-KIND of usage. What is dishonest is a granular kind
// that is not usage at all — 'admin_debit', 'refund', 'adjustment' — carried on
// a row typed 'usage'. So the invariant is not "the two fields must be equal",
// it is "they must belong to the same family".
//
// THROW, NOT COERCE. The alternative was to silently rewrite `type` to
// metadata.ledger_type. Rejected:
//   1. No current caller of insertLedgerEntry sets metadata.ledger_type at all
//      (billing/services/credits.ts x3, billing/services/account-deletion.ts x1),
//      so a throw cannot break live traffic — it is a pure tripwire today.
//   2. Coercion silently rewrites the type column of a MONEY row. Quietly
//      resolving a contradiction in a financial ledger is the same class of
//      behaviour that let the 2026-07-30 rows look plausible for a week. A
//      ledger should refuse a write it cannot make honest, not guess at it.
//   3. The honest shape is always available to the caller: admin/index.ts
//      already passes 'admin_debit' as the row `type` directly.

import { BillingError } from '../errors';

/**
 * Granular kinds that are legitimately carried on a row typed 'usage'.
 *
 * Kept in sync with `LedgerDebitType` (billing/services/credits.ts) and
 * `RouterLedgerDebitType` (repositories/credits.ts) — the two unions of values
 * that reach atomic_use_credits, which hardcodes `type = 'usage'`.
 */
export const USAGE_FAMILY_LEDGER_TYPES = [
  'usage',
  'llm_debit',
  'compute_debit',
  'token_deduction',
  'token_overage',
] as const;

export type UsageFamilyLedgerType = (typeof USAGE_FAMILY_LEDGER_TYPES)[number];

export function isUsageFamilyLedgerType(kind: string): boolean {
  return (USAGE_FAMILY_LEDGER_TYPES as readonly string[]).includes(kind);
}

/**
 * Vocabulary that marks a description as an operator correction rather than
 * customer activity.
 *
 * Deliberately narrow. Every description written on a usage-family row is
 * machine-generated from the thing being billed — 'LLM · anthropic/claude-…',
 * 'Sandbox compute', a tool name — so none of these words can appear there by
 * accident. Free-text descriptions only reach the ledger through admin and
 * reconciliation paths, which is exactly the population this catches.
 */
const CORRECTION_DESCRIPTION_MARKERS = [
  'admin correction',
  'admin debit',
  'admin credit',
  'admin adjustment',
  'manual adjustment',
  'manual correction',
  'reconciliation',
  'reconcile',
  'clawback',
  'claw back',
  'chargeback',
  'write-off',
  'writeoff',
] as const;

export function describesAdminCorrection(description: string | null | undefined): boolean {
  if (!description) return false;
  const text = description.toLowerCase();
  return CORRECTION_DESCRIPTION_MARKERS.some((marker) => text.includes(marker));
}

export class LedgerTypeMismatchError extends BillingError {
  constructor(
    message: string,
    public readonly rowType: string,
    public readonly declaredLedgerType: string | null,
  ) {
    super(message, 500);
    this.name = 'LedgerTypeMismatchError';
  }
}

/** Reads metadata->>'ledger_type' from a value whose shape we do not control. */
export function readDeclaredLedgerType(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const raw = (metadata as Record<string, unknown>).ledger_type;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

export interface LedgerRowForHonestyCheck {
  type: string;
  description?: string | null;
  metadata?: unknown;
}

/**
 * Refuse a credit_ledger row whose `type` contradicts what the row otherwise
 * says about itself. Called on the shared insert path before the row is written.
 */
export function assertLedgerTypeHonesty(row: LedgerRowForHonestyCheck): void {
  const rowType = row.type;
  const declared = readDeclaredLedgerType(row.metadata);

  if (declared !== null && declared !== rowType) {
    const bothUsageFamily = isUsageFamilyLedgerType(rowType) && isUsageFamilyLedgerType(declared);
    if (!bothUsageFamily) {
      throw new LedgerTypeMismatchError(
        `credit_ledger row declares metadata.ledger_type='${declared}' but type='${rowType}'. ` +
          `'${declared}' is not a sub-kind of '${rowType}', so the row would report itself as two ` +
          `different things (the 2026-07-30 mislabelled-clawback incident). Write type='${declared}'.`,
        rowType,
        declared,
      );
    }
  }

  if (isUsageFamilyLedgerType(rowType) && describesAdminCorrection(row.description)) {
    throw new LedgerTypeMismatchError(
      `credit_ledger row has type='${rowType}' but its description reads as an operator ` +
        `correction: ${JSON.stringify(row.description)}. An admin correction is not customer ` +
        `usage — write the correction's own type (e.g. 'admin_debit') so usage aggregation ` +
        `stays truthful (the 2026-07-30 mislabelled-clawback incident).`,
      rowType,
      declared,
    );
  }
}

/**
 * Guard the RPC debit path.
 *
 * atomic_use_credits hardcodes `type = 'usage'` on the row it inserts and copies
 * its `p_ledger_type` argument into metadata verbatim. Passing a non-usage kind
 * through it therefore MANUFACTURES the 2026-07-30 row shape — the caller cannot
 * make that row honest, because it does not control the type column. Reject at
 * the boundary instead.
 */
export function assertRpcDebitLedgerType(ledgerType: string): void {
  if (!isUsageFamilyLedgerType(ledgerType)) {
    throw new LedgerTypeMismatchError(
      `atomic_use_credits writes type='usage' unconditionally, so ledgerType='${ledgerType}' ` +
        `would produce a row that calls itself usage in one column and '${ledgerType}' in ` +
        `another (the 2026-07-30 mislabelled-clawback incident). Non-usage kinds must be ` +
        `written through the ledger insert path with their own type.`,
      'usage',
      ledgerType,
    );
  }
}
