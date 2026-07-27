'use client';

import CreditTransactions from '@/features/billing/credit-transactions';
import EndUserUsageCard from '@/features/billing/end-user-usage-card';

// The accounts page's content pane already renders the "Credits" section
// header; this tab only carries the ledger itself — plus, for Kortix-as-a-Backend
// accounts, the per-end-user spend breakdown (which hides itself otherwise).
export function TransactionsTab() {
  return (
    <div className="space-y-5">
      <EndUserUsageCard />
      <CreditTransactions />
    </div>
  );
}
