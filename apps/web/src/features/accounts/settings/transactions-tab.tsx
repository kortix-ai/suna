'use client';

import CreditTransactions from '@/components/billing/credit-transactions';
import { useTranslations } from 'next-intl';

export function TransactionsTab() {
  const tHardcodedUi = useTranslations('hardcodedUi');

  return (
    <div className="max-w-full min-w-0 space-y-4 overflow-x-hidden p-4 pb-12 sm:p-6 sm:pb-6">
      <div>
        <h3 className="mb-0.5 text-lg font-medium tracking-tight">
          {tHardcodedUi.raw('componentsSettingsUserSettingsModal.line1723JsxTextCreditLedger')}
        </h3>
        <p className="text-muted-foreground text-sm">
          {tHardcodedUi.raw(
            'componentsSettingsUserSettingsModal.line1725JsxTextLedgerBackedAccountEventsFromTheKortixSchema',
          )}
        </p>
      </div>
      <CreditTransactions />
    </div>
  );
}
