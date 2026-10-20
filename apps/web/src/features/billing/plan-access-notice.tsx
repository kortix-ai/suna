'use client';

/**
 * What the account has beyond its billing plan, said where billing is managed
 * (.agents/skills/billing/references/plans-and-access.md):
 *
 *   - an open Enterprise license offer: the terms, and Accept for a billing manager;
 *   - the grace after a license ended: until when SSO and SCIM stay on.
 *
 * Renders nothing for an account with neither.
 */

import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import Loading from '@/components/ui/loading';
import { errorToast } from '@/components/ui/toast';
import { useBillingReturnUrl } from '@/features/billing/billing-return';
import { formatWholeUsd } from '@/features/billing/compute-pricing';
import { useTalkToSales } from '@/features/billing/use-enterprise-sales';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { isBillingEnabled } from '@/lib/config';
import { useBillingAccountId } from '@/stores/billing-account-context';
import { canManageBilling, type AccountState } from '@kortix/sdk';
import { useAcceptEnterpriseOffer } from '@kortix/sdk/react';

function formatDay(iso: string, locale: string): string {
  return new Date(iso).toLocaleDateString(locale, { month: 'long', day: 'numeric', year: 'numeric' });
}

export function PlanAccessNotice({ state }: { state: AccountState }) {
  const t = useTranslations('billing.access');
  const tModel = useTranslations('modelAccess');
  const locale = useLocale();
  const accountId = useBillingAccountId();
  const sales = useTalkToSales(accountId);

  if (!isBillingEnabled()) return null;
  const { enterprise_offer: offer, grace } = state;

  return (
    <div className="space-y-3 empty:hidden">
      {state.model_access?.requires_provider_key ? (
        <InfoBanner tone="info" title={tModel('managedTitle')}>
          {tModel('managedUpgradeHint')}
        </InfoBanner>
      ) : null}
      {offer ? <OfferBanner offer={offer} manager={canManageBilling(state)} /> : null}

      {grace ? (
        <InfoBanner
          tone="warning"
          title={t('graceTitle')}
          action={
            <Button size="sm" variant="outline" disabled={sales.isPending} onClick={sales.talk}>
              {t('talkToSales')}
            </Button>
          }
        >
          {t('graceBodyContract', { date: formatDay(grace.ends_at, locale) })}
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
      {t('offerLicense', { license: formatWholeUsd(offer.license_usd, locale), months: offer.term_months })}{' '}
      {offer.collection !== 'checkout' ? t('offerInvoiced') : manager ? null : t('offerAskManager')}
    </InfoBanner>
  );
}
