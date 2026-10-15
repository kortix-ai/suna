'use client';

/**
 * What the account is on beyond a self-serve plan, said where billing is
 * managed (.agents/skills/billing/references/plans-and-access.md):
 *
 *   - a trial: which plan, until when, and an upgrade at any time;
 *   - an open Enterprise offer: the terms, and Accept for a billing manager;
 *   - the grace after Enterprise access ended: until when SSO and SCIM stay on.
 *
 * Renders nothing for an account with none of the three.
 */

import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import Loading from '@/components/ui/loading';
import { errorToast } from '@/components/ui/toast';
import { useBillingReturnUrl } from '@/features/billing/billing-return';
import { formatWholeUsd } from '@/features/billing/compute-pricing';
import { useRequestDemo } from '@/features/contact/request-demo-provider';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { isBillingEnabled } from '@/lib/config';
import { useBillingAccountId } from '@/stores/billing-account-context';
import { useUpgradeDialogStore } from '@/stores/upgrade-dialog-store';
import { canManageBilling, type AccountState } from '@kortix/sdk';
import { useAcceptEnterpriseOffer } from '@kortix/sdk/react';

function formatDay(iso: string, locale: string): string {
  return new Date(iso).toLocaleDateString(locale, { month: 'long', day: 'numeric', year: 'numeric' });
}

export function PlanAccessNotice({ state }: { state: AccountState }) {
  const t = useTranslations('billing.access');
  const locale = useLocale();
  const accountId = useBillingAccountId();
  const openUpgradeDialog = useUpgradeDialogStore((s) => s.openUpgradeDialog);
  const openDemo = useRequestDemo();

  if (!isBillingEnabled()) return null;
  const manager = canManageBilling(state);
  const { trial, enterprise_offer: offer, grace } = state;
  const enterpriseTrial = trial?.plan === 'enterprise';
  const planName = enterpriseTrial ? t('enterprise') : t('credits');

  const upgrade = () => openUpgradeDialog({ reason: 'subscription_required', accountId: accountId ?? undefined });
  const talkToSales = () => openDemo({ source: 'billing-access-notice' });

  const salesButton = (
    <Button size="sm" variant="outline" onClick={talkToSales}>
      {t('talkToSales')}
    </Button>
  );

  return (
    <div className="space-y-3 empty:hidden">
      {offer ? <OfferBanner offer={offer} manager={manager} /> : null}

      {trial ? (
        <InfoBanner
          tone="info"
          title={t('trialTitle', { plan: planName, days: trial.days_left })}
          action={
            // An Enterprise trial is sold by sales, not by an Upgrade button;
            // a Credits trial converts to the plan the account picks.
            enterpriseTrial ? (
              salesButton
            ) : manager ? (
              <Button size="sm" onClick={upgrade}>
                {t('upgrade')}
              </Button>
            ) : null
          }
        >
          {enterpriseTrial
            ? t('trialBodyEnterprise', { date: formatDay(trial.ends_at, locale) })
            : t('trialBody', { date: formatDay(trial.ends_at, locale) })}{' '}
          {manager || enterpriseTrial ? null : t('askManager')}
        </InfoBanner>
      ) : null}

      {grace ? (
        <InfoBanner
          tone="warning"
          title={t('graceTitle')}
          action={
            <span className="flex flex-wrap gap-2">
              {salesButton}
              {manager && grace.reason === 'trial_ended' ? (
                <Button size="sm" onClick={upgrade}>
                  {t('upgrade')}
                </Button>
              ) : null}
            </span>
          }
        >
          {grace.reason === 'trial_ended'
            ? t('graceBodyTrial', { date: formatDay(grace.ends_at, locale) })
            : t('graceBodyContract', { date: formatDay(grace.ends_at, locale) })}
        </InfoBanner>
      ) : null}
    </div>
  );
}

/**
 * An open Enterprise offer. Its own component so the accept mutation exists
 * only while there is an offer to accept.
 */
function OfferBanner({ offer, manager }: { offer: NonNullable<AccountState['enterprise_offer']>; manager: boolean }) {
  const t = useTranslations('billing.access');
  const locale = useLocale();
  const accountId = useBillingAccountId();
  const billingReturnUrl = useBillingReturnUrl();
  const accept = useAcceptEnterpriseOffer();

  const acceptOffer = () =>
    accept.mutate(
      {
        successUrl: billingReturnUrl('enterprise_contract'),
        cancelUrl: window.location.href,
        accountId: accountId ?? undefined,
      },
      {
        onSuccess: (result) => {
          window.location.href = result.checkout_url;
        },
        onError: (error) => errorToast(t('offerFailed'), { description: error.message }),
      },
    );

  return (
    <InfoBanner
      tone="info"
      title={t('offerTitle')}
      action={
        offer.collection === 'checkout' && manager ? (
          <Button size="sm" className="gap-1.5" onClick={acceptOffer} disabled={accept.isPending}>
            {accept.isPending ? <Loading className="size-4 shrink-0" /> : null}
            {t('offerAccept')}
          </Button>
        ) : null
      }
    >
      {t('offerBody', {
        license: formatWholeUsd(offer.license_usd, locale),
        credits: formatWholeUsd(offer.credits_usd, locale),
        months: offer.term_months,
      })}{' '}
      {offer.collection !== 'checkout' ? t('offerInvoiced') : manager ? null : t('askManager')}
    </InfoBanner>
  );
}
