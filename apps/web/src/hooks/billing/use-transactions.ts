import { useQuery } from '@tanstack/react-query';
import { backendApi } from '@/lib/api-client';
import { accountStateKeys } from './use-account-state';
import { dollarsToCredits } from '@kortix/shared';

export interface CreditTransaction {
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

export interface TransactionsResponse {
  transactions: CreditTransaction[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    has_more: boolean;
  };
}

export interface TransactionsSummary {
  totalCredits: number;
  totalDebits: number;
  count: number;
}

export function useTransactions(
  limit: number = 50,
  offset: number = 0,
  typeFilter?: string | string[]
) {
  const normalizedTypeFilter = Array.isArray(typeFilter)
    ? typeFilter.join(',')
    : typeFilter;

  return useQuery<TransactionsResponse>({
    queryKey: [...accountStateKeys.transactions(limit, offset), normalizedTypeFilter],
    queryFn: async () => {
      const params = new URLSearchParams({
        limit: limit.toString(),
        offset: offset.toString(),
      });

      if (normalizedTypeFilter) {
        params.append('type_filter', normalizedTypeFilter);
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

export function useTransactionsSummary(days: number = 30) {
  return useQuery<TransactionsSummary>({
    queryKey: [...accountStateKeys.transactions(), 'summary', days],
    queryFn: async () => {
      const response = await backendApi.get(`/billing/transactions/summary?days=${days}`);
      if (response.error) {
        throw new Error(response.error.message);
      }
      
      const data = response.data as TransactionsSummary;
      return {
        totalCredits: dollarsToCredits(data.totalCredits),
        totalDebits: dollarsToCredits(data.totalDebits),
        count: data.count,
      };
    },
    staleTime: 60000,
  });
} 
