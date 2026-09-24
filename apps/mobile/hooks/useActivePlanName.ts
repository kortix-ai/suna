import { useActiveAccount } from '@/hooks/useActiveAccount';
import { useAccountState } from '@/lib/billing/hooks';

/**
 * The active account's plan: the API's trial-aware family label, "Free",
 * "Team" or "Enterprise" (`plan.label`). `undefined` until the account state
 * loads. Legacy tier names (`subscription.tier_display_name`) are not shown
 * (Jay, 2026-09-23).
 */
export function useActivePlanName(): string | undefined {
  const { account: activeAccount } = useActiveAccount();
  const { data: accountState } = useAccountState({
    accountId: activeAccount?.account_id ?? undefined,
    enabled: !!activeAccount,
  });
  return accountState?.plan?.label || undefined;
}
