'use client';

import { SectionCard } from '@/components/ui/section-card';
import CreditTransactions from '@/features/billing/credit-transactions';
import { useTranslations } from 'next-intl';

export function TransactionsTab() {
  const tHardcodedUi = useTranslations('hardcodedUi');

  return (
    <SectionCard
      title={tHardcodedUi.raw('componentsSettingsUserSettingsModal.line1723JsxTextCreditLedger')}
      description={tHardcodedUi.raw(
        'componentsSettingsUserSettingsModal.line1725JsxTextLedgerBackedAccountEventsFromTheKortixSchema',
      )}
    >
      <CreditTransactions />
    </SectionCard>
  );
}
