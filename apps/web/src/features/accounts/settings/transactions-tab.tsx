'use client';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@kortix/ui/tabs';
import { useHubSearchParams } from '@kortix/ui/internal/account-hub/account-hub-location';
import { AccountOverviewTab } from '@/features/billing/account-overview';
import { CostExplorer } from '@/features/billing/cost-explorer/cost-explorer';
import CreditTransactions from '@/features/billing/credit-transactions';
import { useTranslations } from '@/i18n/use-translations';

export function TransactionsTab() {
  const params = useHubSearchParams();
  const initialTab =
    params.get('transactions') === 'credit-ledger' ? 'credit-ledger' : 'session-costs';
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <Tabs key={initialTab} defaultValue={initialTab} className="gap-6">
      <TabsList type="underline">
        <TabsTrigger value="session-costs">{tI18nComplete.raw('textf882140b3577')}</TabsTrigger>
        <TabsTrigger value="credit-ledger">{tI18nComplete.raw('text1a17a48d8496')}</TabsTrigger>
      </TabsList>
      <TabsContent value="session-costs">
        <CostExplorer />
      </TabsContent>
      <TabsContent value="credit-ledger">
        <AccountOverviewTab />
        <CreditTransactions />
      </TabsContent>
    </Tabs>
  );
}
