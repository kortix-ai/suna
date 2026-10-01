import { useBillingAccountId } from '@/stores/billing-account-context';
import { listBillingTransactions, type BillingTransactionsPage } from '@kortix/sdk';
import { dollarsToCredits } from '@kortix/shared';
import { useQuery } from '@tanstack/react-query';
import { accountStateKeys } from './use-account-state';

export function useTransactions(
  limit: number = 50,
  offset: number = 0,
  typeFilter?: string | string[],
  options?: { enabled?: boolean },
) {
  const accountId = useBillingAccountId();
  const normalizedTypeFilter = Array.isArray(typeFilter) ? typeFilter.join(',') : typeFilter;

  return useQuery<BillingTransactionsPage>({
    // Scope the cache slot by account so the BillingTab's history block
    // doesn't leak entries across accounts on a multi-account user.
    queryKey: [
      ...accountStateKeys.transactions(limit, offset),
      normalizedTypeFilter,
      { accountId: accountId ?? null },
    ],
    // Billing-disabled deployments (e.g. self-host with
    // KORTIX_BILLING_INTERNAL_ENABLED=false) have no ledger to fetch — the
    // endpoint 404s "Billing is not enabled". Callers pass `enabled: false` to
    // skip the request entirely rather than surfacing that raw error.
    enabled: options?.enabled ?? true,
    queryFn: async () => {
      const data = await listBillingTransactions({
        accountId: accountId ?? undefined,
        limit,
        offset,
        typeFilter: normalizedTypeFilter,
      });
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
