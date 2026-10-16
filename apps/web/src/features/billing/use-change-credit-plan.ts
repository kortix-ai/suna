'use client';

import { errorToast, infoToast, successToast } from '@/components/ui/toast';
import { useBillingReturnUrl } from '@/features/billing/billing-return';
import { formatWholeUsd, monthlyCreditsForUsd } from '@/features/billing/compute-pricing';
import { invalidateAccountState, useCreatePortalSession } from '@/hooks/billing';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { useBillingAccountId } from '@/stores/billing-account-context';
import { useUpgradeDialogStore } from '@/stores/upgrade-dialog-store';
import { useSetBillingPlan } from '@kortix/sdk/react';
import { formatCredits } from '@kortix/shared';
import { useQueryClient } from '@tanstack/react-query';

/**
 * Choose or change the credits plan: `POST /v1/billing/plan` through the SDK's
 * `useSetBillingPlan`, then the one outcome the response names.
 *
 * - `checkout_created`: the account has no paid subscription. Go to Stripe
 *   Checkout.
 * - `updated`: the subscription changed in place; `change` says how. A raise
 *   (`raised`) is charged now and adds the prorated credits at once; a cut
 *   (`scheduled`) applies at the next renewal; `kept` cancels a scheduled cut.
 * - `unchanged`: the amount equals the current one.
 * - `payment_pending`: the raise needs a payment confirmation this app has no
 *   inline form for, so the billing portal takes it.
 */
export function useChangeCreditPlan() {
  const t = useTranslations('billing.credits.change');
  const locale = useLocale();
  const accountId = useBillingAccountId();
  const queryClient = useQueryClient();
  const billingReturnUrl = useBillingReturnUrl();
  const portal = useCreatePortalSession();
  const setPlan = useSetBillingPlan();

  const change = (monthlyUsd: number) =>
    setPlan.mutate(
      {
        monthlyUsd,
        successUrl: billingReturnUrl('team_signup'),
        cancelUrl: window.location.href,
        locale,
        accountId: accountId ?? undefined,
      },
      {
        onSuccess: async (result) => {
          switch (result.status) {
            case 'checkout_created':
              window.location.href = result.checkout_url;
              return;
            case 'updated': {
              useUpgradeDialogStore.getState().closeUpgradeDialog();
              await invalidateAccountState(queryClient, true, true, accountId ?? undefined);
              const amount = formatWholeUsd(result.monthly_usd, locale);
              if (result.change === 'scheduled') {
                successToast(t('scheduled'), {
                  description: t('scheduledDescription', {
                    amount,
                    date: result.effective_at
                      ? new Date(result.effective_at).toLocaleDateString(locale, { month: 'short', day: 'numeric' })
                      : '',
                  }),
                });
              } else if (result.change === 'kept') {
                successToast(t('kept'), { description: t('keptDescription', { amount }) });
              } else if (result.change === 'raised') {
                successToast(t('raised', { amount }), {
                  description: t('raisedDescription', {
                    due: new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(result.charged_usd ?? 0),
                    credits: formatCredits(result.credits_added ?? 0, { locale }),
                  }),
                });
              } else {
                successToast(t('updated'), {
                  description: t('updatedDescription', {
                    credits: formatCredits(monthlyCreditsForUsd(result.monthly_usd), { locale }),
                  }),
                });
              }
              return;
            }
            case 'unchanged':
              infoToast(t('unchanged'));
              return;
            case 'payment_pending':
              infoToast(t('paymentPending'), { description: t('paymentPendingDescription') });
              portal.mutate({ return_url: window.location.href });
              return;
          }
        },
        onError: (error: unknown) => {
          errorToast(t('failed'), {
            description: error instanceof Error && error.message ? error.message : undefined,
          });
        },
      },
    );

  return { change, isPending: setPlan.isPending || portal.isPending };
}
