import { describe, expect, test, mock } from 'bun:test';

mock.module('@/stores/billing-account-context', () => ({ useBillingAccountId: () => 'account-test' }));
mock.module('@tanstack/react-query', () => ({ useQuery: (options: unknown) => options }));
mock.module('@kortix/sdk', () => ({
  listBillingTransactions: async () => ({
    transactions: [{ id: 'tx-test', amount: 1.25, balance_after: 2.5, type: 'purchase', description: null }],
    pagination: { total: 1, limit: 50, offset: 0, has_more: false },
  }),
}));

import { useTransactions } from './use-transactions';

describe('useTransactions', () => {
  test('converts dollar amounts and balances into credits without changing the row or pagination', async () => {
    const query = useTransactions() as unknown as { queryFn: () => Promise<any> };
    expect(await query.queryFn()).toEqual({
      transactions: [{ id: 'tx-test', amount: 125, balance_after: 250, type: 'purchase', description: null }],
      pagination: { total: 1, limit: 50, offset: 0, has_more: false },
    });
  });
});
