import { useQuery } from '@tanstack/react-query';
import { backendApi } from '@/lib/api-client';
import { accountStateKeys } from './use-account-state';
import { useBillingAccountId } from '@/stores/billing-account-context';
import { dollarsToCredits } from '@kortix/shared';

interface CreditTransaction {
  id: string;
  created_at: string;
  amount: number;
  balance_after: number;
  type:
    | 'tier_grant'
    | 'purchase'
    | 'admin_grant'
    | 'promotional'
    | 'usage'
    | 'refund'
    | 'adjustment'
    | 'expired'
    | 'auto_topup'
    | 'machine_bonus'
    | 'daily_refresh';
  description: string;
  is_expiring?: boolean;
  expires_at?: string;
  metadata?: Record<string, any>;
}

interface TransactionsResponse {
  transactions: CreditTransaction[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    has_more: boolean;
  };
}

export function useTransactions(
  limit: number = 50,
  offset: number = 0,
  typeFilter?: string | string[]
) {
  const accountId = useBillingAccountId();
  const normalizedTypeFilter = Array.isArray(typeFilter)
    ? typeFilter.join(',')
    : typeFilter;

  return useQuery<TransactionsResponse>({
    // Scope the cache slot by account so the BillingTab's history block
    // doesn't leak entries across accounts on a multi-account user.
    queryKey: [
      ...accountStateKeys.transactions(limit, offset),
      normalizedTypeFilter,
      { accountId: accountId ?? null },
    ],
    queryFn: async () => {
      const params = new URLSearchParams({
        limit: limit.toString(),
        offset: offset.toString(),
      });

      if (normalizedTypeFilter) {
        params.append('type_filter', normalizedTypeFilter);
      }
      if (accountId) {
        params.append('account_id', accountId);
      }

      const response = await backendApi.get(`/billing/transactions?${params.toString()}`);
      if (response.error) {
        throw new Error(response.error.message);
      }

      const data = response.data as TransactionsResponse;
      return {
        ...data,
        transactions: data.transactions.map((tx) => ({
          ...tx,
          amount: dollarsToCredits(tx.amount),
          balance_after: dollarsToCredits(tx.balance_after),
        })),
      };
    },
    staleTime: 30000,
  });
}
