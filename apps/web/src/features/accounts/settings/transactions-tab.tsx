'use client';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import CreditTransactions from '@/features/billing/credit-transactions';
import { SessionCostExplorer } from '@/features/billing/session-cost-explorer';

export function TransactionsTab() {
  return (
    <Tabs defaultValue="session-costs" className="gap-6">
      <TabsList type="underline">
        <TabsTrigger value="session-costs">Session costs</TabsTrigger>
        <TabsTrigger value="credit-ledger">Credit ledger</TabsTrigger>
      </TabsList>
      <TabsContent value="session-costs">
        <SessionCostExplorer />
      </TabsContent>
      <TabsContent value="credit-ledger">
        <CreditTransactions />
      </TabsContent>
    </Tabs>
  );
}
