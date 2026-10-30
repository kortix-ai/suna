'use client';

import { useAccountDetail } from '@kortix/ui/internal/account-hub/use-account-detail';
import { Button } from '@kortix/ui/button';
import { ConfirmDialog } from '@kortix/ui/confirm-dialog';
import { InfoBanner } from '@kortix/ui/info-banner';
import Loading from '@kortix/ui/loading';
import { SettingsRow, SettingsRowGroup } from '@kortix/ui/settings-row';
import { Skeleton } from '@kortix/ui/skeleton';
import { AccountOverviewTab } from '@/features/billing/account-overview';
import { PlanCard, PlanChanger } from '@/features/billing/plan-card';
import { EnterpriseAccessRow } from '@/features/billing/enterprise-access-row';
import { PlanAccessNotice } from '@/features/billing/plan-access-notice';
import { TopupControls } from '@/features/billing/topup-controls';
import { useAuth } from '@/features/providers/auth-provider';
import {
  accountStateKeys,
  accountStateSelectors,
  invalidateAccountState,
  useCancelSubscription,
  useCreatePortalSession,
  useReactivateSubscription,
} from '@kortix/ui/internal/billing/index';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { isBillingEnabled } from '@/lib/config';
import { useBillingAccountId } from '@kortix/ui/internal/stores/billing-account-context';
import { useUserSettingsModalStore } from '@/stores/user-settings-modal-store';
import { getAccountState, type AccountState } from '@kortix/sdk';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

/**
 * `showWallet` — whether this pane leads with the WALLET or with the PLAN.
 *
 * `true` (the default, and what `/accounts/[id]?tab=billing` uses): the
 * balance card, this period's spend, the limits, and the plan changer under
 * them — when the wallet leads at all (third rule below).
 *
 * `false` (the settings overlay's Plan tab, 2026-09-03): the wallet blocks are
 * dropped and `PlanCard` leads instead. Every number they showed — balance,
 * credit composition, compute/LLM spend, limits — is the subject of the
 * Credits pane beside it (`settings/tabs/credits-tab.tsx`), so on Plan they
 * were a duplicate. `PlanCard` carries the plan changer itself.
 *
 * The wallet blocks also require the PLAN'S answer, not just the caller's:
 * they render for a wallet the plan can fund —
 * `subscription.can_purchase_credits` (KRTX-2376). On Free the hub's
 * wallet-first view printed a balance its plan can never refill — the only
 * top-up control in the product lives behind the subscribe dialog — so the
 * pane falls to the `PlanCard` (the same shape the `false` view draws),
 * whose card carries the monthly grant; the balance and top-up return the
 * moment the plan allows purchases.
 *
 * What does NOT vary: buying credits, auto top-up, and the Stripe portal stay
 * on both purchasable views. They are the actions this pane exists to offer,
 * and the Credits pane's "Add credits" button navigates here to reach them.
 */
export function BillingTab({
  returnUrl,
  isActive,
  showWallet = true,
}: {
  returnUrl: string;
  isActive: boolean;
  showWallet?: boolean;
}) {
  const t = useTranslations('billing.plan');
  // The cancel dialog's dismiss label. `settings.billing.keepSubscription`
  // is the existing, fully translated string for exactly this dialog — reuse
  // it rather than adding a second copy of the same sentence.
  const tBillingDialog = useTranslations('settings.billing');
  const locale = useLocale();
  const { session, isLoading: authLoading } = useAuth();
  const highlight = useUserSettingsModalStore((s) => s.highlight);
  const queryClient = useQueryClient();
  const billingAccountId = useBillingAccountId();

  const members = useAccountDetail(billingAccountId);

  const {
    data: accountState,
    isLoading: isLoadingSubscription,
    error: subscriptionError,
  } = useQuery<AccountState>({
    queryKey: accountStateKeys.state(billingAccountId),
    queryFn: () => getAccountState({ accountId: billingAccountId }),
    enabled: !!session && !authLoading,
    staleTime: 1000 * 60 * 2,
    gcTime: 1000 * 60 * 15,
    refetchOnWindowFocus: false,
    refetchOnMount: true,
  });

  const createPortalSessionMutation = useCreatePortalSession();
  const cancelSubscriptionMutation = useCancelSubscription();
  const reactivateSubscriptionMutation = useReactivateSubscription();
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const totalCredits = accountStateSelectors.totalCredits(accountState);

  const prevIsActiveRef = useRef(false);
  useEffect(() => {
    if (isActive && !prevIsActiveRef.current && session && !authLoading) {
      invalidateAccountState(queryClient, true);
    }
    prevIsActiveRef.current = isActive;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, session, authLoading]);

  const handleManageSubscription = () => {
    createPortalSessionMutation.mutate({ return_url: returnUrl });
  };

  const isLoading = isLoadingSubscription || authLoading;
  const error = subscriptionError
    ? subscriptionError instanceof Error
      ? subscriptionError.message
      : t('loadFailed')
    : null;

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-32 w-full rounded-md" />
        <Skeleton className="h-32 w-full rounded-md" />
      </div>
    );
  }

  if (error) {
    return <InfoBanner tone="destructive">{error}</InfoBanner>;
  }

  const subscription = accountState?.subscription;
  const canPurchaseCredits = subscription?.can_purchase_credits || false;
  // The wallet blocks are for a wallet the plan can FUND. A plan that cannot
  // purchase credits (Free) would show a balance its plan can never refill —
  // the dead-end wallet of the dogfood finding (KRTX-2376) — so the caller's
  // `showWallet` and the plan's own answer must both hold for the wallet to
  // lead this pane. See the docblock above.
  const walletVisible = showWallet && canPurchaseCredits;
  const hasActiveSubscription = Boolean(subscription?.subscription_id);
  const subscriptionCancelling = subscription?.cancel_at_period_end === true;
  // The cancel control lives on the pane a paying customer manages their
  // subscription from. A pending cancellation renders Reactivate instead of a
  // second Cancel; an active commitment disables Cancel with the date it
  // unlocks — the route (subscriptions.ts) enforces the same rule, this only
  // says it before the click. Older API responses omit `commitment`:
  // undefined still means "allowed".
  const canCancelSubscription = subscription?.commitment?.can_cancel !== false;
  const commitmentEnd = subscription?.commitment?.commitment_end_date
    ? new Date(subscription.commitment.commitment_end_date)
    : null;

  return (
    <div className="space-y-8">
      {/* The out-of-credits warning is a WALLET message and stays with the
          wallet blocks — it can never tell a Free account to top up a wallet
          its plan cannot fund. On the Plan tab the same account reads its
          balance on the Credits pane, which shows the shortfall in the number
          itself rather than in a banner over a pane about subscriptions. */}
      {walletVisible && highlight === 'credits' && totalCredits <= 0 && (
        <InfoBanner tone="warning" title={t('outOfCredits')}>
          {/* This banner only leads the wallet blocks, so the plan can always
              purchase credits here — "buy credits below or turn on auto
              top-up" is the only advice it can give. */}
          {/* ponytail: `topupWalletHint` is unreachable in every catalog now
              (KRTX-2376); prune the key across the nine locales when i18n
              churn is cheap — the copy collapse stayed inside this diff. */}
          {t('buyCreditsHint')}
        </InfoBanner>
      )}

      {/* An Enterprise license offer, or the grace after a license ended:
          stated before anything else. */}
      {accountState ? <PlanAccessNotice state={accountState} /> : null}

      {walletVisible ? (
        <>
          <AccountOverviewTab accountId={billingAccountId} />
          {accountState ? (
            <PlanChanger state={accountState} className="bg-popover rounded-md border" />
          ) : null}
        </>
      ) : accountState ? (
        <PlanCard state={accountState} />
      ) : null}

      <SettingsRowGroup>
        <SettingsRow label={t('members')} description={t('unlimitedMembers')}>
          <span className="text-sm tabular-nums" aria-live="polite">
            {members.isLoading
              ? t('loadingMembers')
              : members.isError || members.data?.member_count === undefined
                ? t('membersUnavailable')
                : t('memberCount', { count: members.data.member_count })}
          </span>
        </SettingsRow>
      </SettingsRowGroup>

      {/* Add credits and Auto top-up share one card, matching the settings
              pane. Both components carry their own heading and no chrome
              (see `credit-topup-section.tsx` / `auto-topup-card.tsx`), so the
              outer headings this section used to draw would now read twice.

              Wallet-only (Jay, 2026-09-03: "the add credit component will be
              coming in the credit tab content only, not in the plan row").
              The settings overlay's Credits pane mounts these same two
              components itself — buying credits belongs beside the balance it
              changes, not on a pane about a subscription. `TopupControls`
              renders them only when the plan may buy credits and this person
              may change billing (KRTX-1720). */}
      {walletVisible ? <TopupControls state={accountState} heading={t('addCredits')} /> : null}

      {/* Enterprise is a feature layer, separate from the plan: off, a
          self-serve demo, or licensed. Hidden when a self-host Enterprise
          license already turns every feature on. */}
      {accountState && !accountState.enterprise_license_available ? (
        <SettingsRowGroup>
          <EnterpriseAccessRow state={accountState} accountId={billingAccountId} />
        </SettingsRowGroup>
      ) : null}

      {/* The Stripe billing portal doesn't exist without billing enabled
              (self-host with KORTIX_BILLING_INTERNAL_ENABLED=false) — hide the
              button rather than let it 404/error on click. */}
      {isBillingEnabled() ? (
        <section>
          {/* One row, Linear's shape: what the portal is on the left,
                  every subscription action on the right. The commitment hint
                  joins the description instead of a third line in a box. */}
          <SettingsRowGroup>
            <SettingsRow
              label={t('billingPortal')}
              description={
                <>
                  {t('portalDescription')}
                  {hasActiveSubscription && !canCancelSubscription && commitmentEnd ? (
                    <span className="mt-1 block">
                      {t('commitmentCancelHint', {
                        date: commitmentEnd.toLocaleDateString(locale, {
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric',
                        }),
                      })}
                    </span>
                  ) : null}
                </>
              }
            >
              {subscriptionCancelling ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="gap-1.5"
                  onClick={() => reactivateSubscriptionMutation.mutate()}
                  disabled={reactivateSubscriptionMutation.isPending}
                >
                  {reactivateSubscriptionMutation.isPending ? (
                    <Loading className="size-4 shrink-0" />
                  ) : null}
                  {t('reactivateSubscription')}
                </Button>
              ) : hasActiveSubscription ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => setConfirmingCancel(true)}
                  disabled={!canCancelSubscription}
                >
                  {t('cancelSubscription')}
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                onClick={handleManageSubscription}
                disabled={createPortalSessionMutation.isPending}
              >
                {createPortalSessionMutation.isPending ? (
                  <Loading className="size-4 shrink-0" />
                ) : null}
                {t('manageBilling')}
              </Button>
            </SettingsRow>
          </SettingsRowGroup>
          {hasActiveSubscription ? (
            <ConfirmDialog
              open={confirmingCancel}
              onOpenChange={setConfirmingCancel}
              title={t('cancelSubscription')}
              description={t('cancelSubscriptionDescription')}
              confirmLabel={t('cancelSubscription')}
              cancelLabel={tBillingDialog('keepSubscription')}
              confirmVariant="destructive"
              isPending={cancelSubscriptionMutation.isPending}
              onConfirm={() => {
                setConfirmingCancel(false);
                cancelSubscriptionMutation.mutate();
              }}
            />
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
