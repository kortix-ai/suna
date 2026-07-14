'use client';

import CreditTransactions from '@/features/billing/credit-transactions';

// The accounts page's content pane already renders the "Credits" section
// header; this tab only carries the ledger itself.
export function TransactionsTab() {
  return <CreditTransactions />;
}
