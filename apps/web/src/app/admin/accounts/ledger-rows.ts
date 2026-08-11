/**
 * Admin ledger → the customer-facing ledger table.
 *
 * `GET /admin/api/accounts/{id}/ledger` and `GET /billing/transactions` return
 * the same `credit_ledger` rows under different field names, and the admin one
 * ships its amounts as numeric strings (NUMERIC columns over JSON). This is the
 * whole adapter — with it, the admin sheet renders
 * {@link CreditTransactionsTable} instead of a second, drifting list.
 */
import type { AdminLedgerEntry } from '@/hooks/admin/use-admin-accounts';
import type { CreditTransactionRow } from '@/features/billing/transactions-table';

/** `'25.00'` → `25`. An unusable value reads as 0: a NaN in a money column is worse. */
function amount(value: string | null | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function adminLedgerRows(entries: AdminLedgerEntry[]): CreditTransactionRow[] {
  return entries.map((entry) => ({
    id: entry.id,
    createdAt: entry.createdAt,
    type: entry.type,
    description: entry.description,
    // The column is nullable. Null is "unknown", not "permanent", so the cell
    // stays empty rather than asserting something the row does not say.
    isExpiring: entry.isExpiring ?? undefined,
    amount: amount(entry.amount),
    balanceAfter: amount(entry.balanceAfter),
  }));
}
