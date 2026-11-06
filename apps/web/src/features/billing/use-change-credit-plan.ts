'use client';

import { errorToast, infoToast, successToast } from '@kortix/ui/toast';
import { useBillingReturnUrl } from '@/features/billing/billing-return';
import { formatWholeUsd, monthlyCreditsForUsd } from '@kortix/ui/internal/billing/compute-pricing';
import { invalidateAccountState, useCreatePortalSession } from '@kortix/ui/internal/billing/index';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { useBillingAccountId } from '@kortix/ui/internal/stores/billing-account-context';
import { useUpgradeDialogStore } from '@kortix/ui/internal/stores/upgrade-dialog-store';
import type { SetBillingPlanResult } from '@kortix/sdk';
import { useSetBillingPlan } from '@kortix/sdk/react';
import { formatCredits } from '@kortix/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { confirmPendingPlanPayment, loadStripeJs } from './confirm-plan-payment';

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
 * - `payment_pending`: the raise needs the payer. Stripe.js confirms it on the
 *   saved card with `client_secret` (3-D Secure); a decline or no secret opens
 *   the billing portal.
 *
 * One change at a time: a synchronous ref guard, and `isPending` stays true
 * while the browser leaves for Stripe Checkout, so Subscribe cannot create a
 * second Checkout Session.
 */
export function useChangeCreditPlan() {
  const t = useTranslations('billing.credits.change');
  const locale = useLocale();
  const accountId = useBillingAccountId();
  const queryClient = useQueryClient();
  const billingReturnUrl = useBillingReturnUrl();
  const portal = useCreatePortalSession();
  const setPlan = useSetBillingPlan();
  const inFlightRef = useRef(false);
  const [redirecting, setRedirecting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // Back from Checkout restores this page from the back/forward cache with
  // the guard closed: open it again.
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      inFlightRef.current = false;
      setRedirecting(false);
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, []);

  const applied = async (monthlyUsd: number) => {
    useUpgradeDialogStore.getState().closeUpgradeDialog();
    await invalidateAccountState(queryClient, true, true, accountId ?? undefined);
    return formatWholeUsd(monthlyUsd, locale);
  };

  const announce = async (result: SetBillingPlanResult) => {
    switch (result.status) {
      case 'checkout_created':
        setRedirecting(true);
        window.location.href = result.checkout_url;
        return;
      case 'updated': {
        const amount = await applied(result.monthly_usd);
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
      case 'payment_pending': {
        setConfirming(true);
        const outcome = await confirmPendingPlanPayment(result.client_secret, {
          loadStripe: loadStripeJs,
          publishableKey: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || '',
        }).finally(() => setConfirming(false));
        if (outcome === 'needs-portal') {
          infoToast(t('paymentPending'), { description: t('paymentPendingDescription') });
          portal.mutate({ return_url: window.location.href });
          return;
        }
        // Confirmed (or processing): `invoice.paid` applies the raise and
        // grants its credits.
        await applied(result.monthly_usd);
        successToast(t('updated'), {
          description: t('updatedDescription', {
            credits: formatCredits(monthlyCreditsForUsd(result.monthly_usd), { locale }),
          }),
        });
        return;
      }
      default: {
        // A status this client does not know: say so instead of nothing.
        const unknownResult: never = result;
        void unknownResult;
        errorToast(t('failed'));
      }
    }
  };

  const change = (monthlyUsd: number) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
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
          try {
            await announce(result);
          } finally {
            // The page is leaving for Checkout: the guard stays closed.
            if (result.status !== 'checkout_created') inFlightRef.current = false;
          }
        },
        onError: (error: unknown) => {
          inFlightRef.current = false;
          errorToast(t('failed'), {
            description: error instanceof Error && error.message ? error.message : undefined,
          });
        },
      },
    );
  };

  return { change, isPending: setPlan.isPending || portal.isPending || redirecting || confirming };
}
