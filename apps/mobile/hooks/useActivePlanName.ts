import { useActiveAccount } from '@/hooks/useActiveAccount';
import { useAccountState } from '@/lib/billing/hooks';
import { useTranslation } from 'react-i18next';

/**
 * The active account's plan: the API's trial-aware family label, "Free",
 * "Credits" or "Enterprise" (`plan.label`), and on a trial the days left
 * ("Enterprise trial · 9 days left"), so a trial is never a surprise when it
 * ends. `undefined` until the account state loads. Legacy tier names
 * (`subscription.tier_display_name`) are not shown (Jay, 2026-09-23).
 */
export function useActivePlanName(): string | undefined {
  const { account: activeAccount } = useActiveAccount();
  const { data: accountState } = useAccountState({
    accountId: activeAccount?.account_id ?? undefined,
    enabled: !!activeAccount,
  });
  const { t } = useTranslation();
  const label = accountState?.plan?.label || undefined;
  const trial = accountState?.trial;
  if (label && trial) return t('plans.trialLabel', { plan: label, count: trial.days_left });
  return label;
}
