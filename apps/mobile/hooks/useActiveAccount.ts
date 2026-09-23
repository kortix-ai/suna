/**
 * The account the app is working in: the persisted selection from
 * `useCurrentAccountStore`, or the first account when nothing is selected
 * (or the selection no longer exists). The Account page and Billing read the
 * same account, so the plan badge and the credit balance always agree.
 */

import { useAuthContext } from '@/contexts';
import { useAccounts } from '@/lib/projects/hooks';
import { useCurrentAccountStore } from '@/stores/current-account-store';

export function useActiveAccount() {
  const { user } = useAuthContext();
  const accountsQuery = useAccounts(!!user);
  const selectedAccountId = useCurrentAccountStore((s) => s.selectedAccountId);

  const account =
    accountsQuery.data?.find((a) => a.account_id === selectedAccountId) ??
    accountsQuery.data?.[0] ??
    null;

  return { account, isLoading: accountsQuery.isLoading };
}
