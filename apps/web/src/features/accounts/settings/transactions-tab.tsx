'use client';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { CostExplorer } from '@/features/billing/cost-explorer/cost-explorer';
import CreditTransactions from '@/features/billing/credit-transactions';
import { useTranslations } from '@/i18n/use-translations';

export function TransactionsTab() {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <Tabs defaultValue="session-costs" className="gap-6">
      <TabsList type="underline">
        <TabsTrigger value="session-costs">{tI18nComplete.raw('textf882140b3577')}</TabsTrigger>
        <TabsTrigger value="credit-ledger">{tI18nComplete.raw('text1a17a48d8496')}</TabsTrigger>
      </TabsList>
      <TabsContent value="session-costs">
        <CostExplorer />
      </TabsContent>
      <TabsContent value="credit-ledger">
        <CreditTransactions />
      </TabsContent>
    </Tabs>
  );
}
