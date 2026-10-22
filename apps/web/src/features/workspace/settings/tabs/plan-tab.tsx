'use client';

/**
 * The Plan tab — the account's subscription, credits, and billing portal.
 *
 * Added 2026-09-02 (Jay: "there should be a section for the plan that shows
 * the subscription and the current plan"). It is a second door onto the SAME
 * component `/accounts/[id]?tab=billing` renders — `BillingTab` in
 * `features/accounts/settings/billing-tab.tsx` — mounted with the same
 * provider and the same gate. One component, two mounts; the only difference
 * is `showWallet`, which chooses which of the two blocks leads (see the JSX
 * below and `BillingTab`'s own doc comment). No billing LOGIC is forked:
 *
 * - `BillingAccountProvider` scopes every billing hook below to THIS account,
 *   so a multi-account user never reads or mutates their primary account by
 *   accident.
 * - `GlobalUpgradeModal` is mounted beside it because the "Subscribe" button
 *   opens the global upgrade-dialog store, and the global renderer lives only
 *   on share pages.
 * - The gate is `account.write`, exactly as the account page gates its Billing
 *   tab. A member without it sees who to ask instead of a pane of buttons that
 *   would each fail.
 *
 * The Stripe portal's `return_url` must be absolute; `/settings/plan` is the
 * route that reopens this overlay on this very tab, so a person who leaves for
 * the portal lands back here.
 */

import { HubLink } from '@kortix/ui/internal/account-hub/account-hub-location';
import { hubTarget } from '@kortix/ui/internal/stores/account-panel-store';
import { Button } from '@kortix/ui/button';
import { SettingsRow, SettingsRowGroup } from '@kortix/ui/settings-row';
import { Skeleton } from '@kortix/ui/skeleton';
import { BillingTab } from '@/features/accounts/settings/billing-tab';
import { GlobalUpgradeModal } from '@/features/billing/global-upgrade-modal';
import { usePermission } from '@kortix/ui/workspace';
import { BillingAccountProvider } from '@kortix/ui/internal/stores/billing-account-context';
import { useTranslations } from '@/i18n/use-translations';
import Link from 'next/link';
import { SettingsTabHeader } from '@kortix/ui/customize/settings/settings-tab-header';

function planReturnUrl(): string {
  return typeof window !== 'undefined'
    ? `${window.location.origin}/settings/plan`
    : '/settings/plan';
}

export function PlanTab({ accountId }: { accountId: string | undefined }) {
  const t = useTranslations('settings.plan');
  const canWrite = usePermission(accountId, 'account.write');

  return (
    <div className="mx-auto w-full max-w-2xl space-y-8">
      <SettingsTabHeader tab="plan" />

      {!accountId || canWrite.isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-32 w-full rounded-md" />
          <Skeleton className="h-32 w-full rounded-md" />
        </div>
      ) : canWrite.allowed ? (
        <BillingAccountProvider accountId={accountId}>
          {/* `showWallet={false}`: the pane leads with `PlanCard` — the
              subscription, its monthly amount, and the picker that changes
              it — instead of the wallet-first `AccountOverviewTab`. Balance,
              credit composition, period spend and limits are the Credits
              pane's subject (`tabs/credits-tab.tsx`), one row above this one
              in the rail. The hub's Billing pane passes nothing and keeps the
              wallet-first layout. */}
          <BillingTab returnUrl={planReturnUrl()} isActive showWallet={false} />
          <GlobalUpgradeModal />
        </BillingAccountProvider>
      ) : (
        <SettingsRowGroup>
          <SettingsRow label={t('managedByAdmin')} description={t('adminOnly')}>
            <Button asChild variant="secondary" size="sm">
              <HubLink to={hubTarget(accountId)}>{t('openAccount')}</HubLink>
            </Button>
          </SettingsRow>
        </SettingsRowGroup>
      )}
    </div>
  );
}
