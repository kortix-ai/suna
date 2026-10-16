import { useActiveAccount } from '@/hooks/useActiveAccount';
import { useAccountState } from '@/lib/billing/hooks';
import { useTranslation } from 'react-i18next';

/**
 * The active account's plan: the billing plan's family label, "Free" or
 * "Credits" (`plan.label`), plus the Enterprise layer when it is on
 * ("Credits · Enterprise demo", "Credits · Enterprise"). `undefined` until the
 * account state loads. Legacy tier names (`subscription.tier_display_name`)
 * are not shown (Jay, 2026-09-23).
 */
export function useActivePlanName(): string | undefined {
  const { account: activeAccount } = useActiveAccount();
  const { data: accountState } = useAccountState({
    accountId: activeAccount?.account_id ?? undefined,
    enabled: !!activeAccount,
  });
  const { t } = useTranslation();
  const label = accountState?.plan?.label || undefined;
  const enterprise = accountState?.enterprise?.state;
  if (label && enterprise === 'demo') return t('plans.enterpriseDemoLabel', { plan: label });
  if (label && enterprise === 'licensed') return t('plans.enterpriseLabel', { plan: label });
  return label;
}
