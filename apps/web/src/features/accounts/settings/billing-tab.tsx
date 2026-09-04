'use client';

import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import { AccountOverviewTab } from '@/features/billing/account-overview';
import { AutoTopupCard } from '@/features/billing/auto-topup-card';
import { ClaimPerSeatCard } from '@/features/billing/claim-per-seat-card';
import { CreditTopupSection } from '@/features/billing/credit-topup-section';
import { PlanCard } from '@/features/billing/plan-card';
import { SeatManagementCard } from '@/features/billing/seat-management-card';
import { useAuth } from '@/features/providers/auth-provider';
import {
  accountStateKeys,
  accountStateSelectors,
  invalidateAccountState,
  useCreatePortalSession,
} from '@/hooks/billing';
import { getAccountState, type AccountState } from '@kortix/sdk';
import { isBillingEnabled } from '@/lib/config';
import { useBillingAccountId } from '@/stores/billing-account-context';
import { useUpgradeDialogStore } from '@/stores/upgrade-dialog-store';
import { useUserSettingsModalStore } from '@/stores/user-settings-modal-store';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useRef } from 'react';

/**
 * `showWallet` — whether this pane leads with the WALLET or with the PLAN.
 *
 * `true` (the default, and what `/accounts/[id]?tab=billing` uses): unchanged
 * since 2026-08-13 — the balance card, this period's spend, the limits, and
 * the seat card under them.
 *
 * `false` (the settings overlay's Plan tab, 2026-09-03): the wallet blocks are
 * dropped and `PlanCard` leads instead. Every number they showed — balance,
 * credit composition, compute/LLM spend, limits — is the subject of the
 * Credits pane beside it (`settings/tabs/credits-tab.tsx`), so on Plan they
 * were a duplicate. `SeatManagementCard` goes with them: `PlanCard` prints the
 * same three seat figures as properties, and rendering both states the seat
 * count three times across two boxes.
 *
 * What does NOT vary: buying credits, auto top-up, and the Stripe portal stay
 * on both. They are the actions this pane exists to offer, and the Credits
 * pane's "Add credits" button navigates here to reach them.
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
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const { session, isLoading: authLoading } = useAuth();
  const highlight = useUserSettingsModalStore((s) => s.highlight);
  const openUpgradeDialog = useUpgradeDialogStore((s) => s.openUpgradeDialog);
  const queryClient = useQueryClient();
  const billingAccountId = useBillingAccountId();

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
    refetchInterval: (query) => {
      const data = query.state.data as AccountState | undefined;
      const hasProvisioning = data?.instances?.some(
        (i: { status: string }) => i.status === 'provisioning',
      );
      return hasProvisioning ? 5000 : false;
    },
    refetchIntervalInBackground: false,
  });

  const createPortalSessionMutation = useCreatePortalSession();
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
      : 'Failed to load subscription data'
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
  const isPerSeat = accountState?.billing_model === 'per_seat';
  const hasActiveSubscription = Boolean(subscription?.subscription_id);
  const subscribedToTeam = isPerSeat && hasActiveSubscription;
  const showTeamCheckout = isBillingEnabled() && !hasActiveSubscription;

  return (
    <div className="space-y-8">
      {showTeamCheckout ? (
        <section className="space-y-4">
          <div className="space-y-1">
            <Label>Kortix Team</Label>
            <p className="text-muted-foreground text-xs">
              {tI18nHardcoded.raw(
                'autoFeaturesAccountsSettingsBillingTabJsxTextSubscribeToPut67032571',
              )}
            </p>
          </div>
          <div className="bg-popover rounded-md border px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Button
                size="sm"
                onClick={() =>
                  openUpgradeDialog({
                    reason: 'subscription_required',
                    accountId: billingAccountId,
                  })
                }
                className="shrink-0"
              >
                Subscribe to Team
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-foreground gap-1.5"
                onClick={handleManageSubscription}
                disabled={createPortalSessionMutation.isPending}
              >
                {createPortalSessionMutation.isPending ? (
                  <Loading className="size-4 shrink-0" />
                ) : null}
                Manage billing
              </Button>
            </div>
          </div>
        </section>
      ) : (
        <>
          {/* The out-of-credits warning is a WALLET message and stays with
              the wallet. On the Plan tab the same account reads its balance on
              the Credits pane, which shows the shortfall in the number itself
              rather than in a banner over a pane about subscriptions. */}
          {showWallet && highlight === 'credits' && totalCredits <= 0 && (
            <InfoBanner
              tone="warning"
              title={tI18nHardcoded.raw(
                'autoFeaturesAccountsSettingsBillingTabJsxAttrTitleYouRanefc3b00e',
              )}
            >
              {canPurchaseCredits
                ? 'Buy credits below or turn on auto top-up so it never happens again.'
                : 'Top up your wallet to keep your agents running.'}
            </InfoBanner>
          )}

          {showWallet ? (
            <AccountOverviewTab accountId={billingAccountId} />
          ) : accountState ? (
            <PlanCard state={accountState} />
          ) : null}

          {accountState?.can_claim_per_seat && <ClaimPerSeatCard accountState={accountState} />}

          {showWallet && subscribedToTeam && <SeatManagementCard accountState={accountState} />}

          {/* Add credits and Auto top-up share one card, matching the settings
              pane. Both components carry their own heading and no chrome
              (see `credit-topup-section.tsx` / `auto-topup-card.tsx`), so the
              outer headings this section used to draw would now read twice.

              Wallet-only (Jay, 2026-09-03: "the add credit component will be
              coming in the credit tab content only, not in the plan row").
              The settings overlay's Credits pane mounts these same two
              components itself — buying credits belongs beside the balance it
              changes, not on a pane about a subscription. */}
          {showWallet && canPurchaseCredits && (
            <div className="bg-popover rounded-md border">
              <section className="space-y-3 px-4 py-4">
                <h3 className="text-foreground text-sm font-medium">Add credits</h3>
                <CreditTopupSection />
              </section>
              <div className="border-t px-4 py-4">
                <AutoTopupCard fetchSettings showSaveButton />
              </div>
            </div>
          )}

          {/* The Stripe billing portal doesn't exist without billing enabled
              (self-host with KORTIX_BILLING_INTERNAL_ENABLED=false) — hide the
              button rather than let it 404/error on click. */}
          {isBillingEnabled() ? (
            <section className="space-y-4">
              <Label>Billing portal</Label>
              <div className="bg-popover rounded-md border px-4 py-3">
                <div className="flex items-center justify-between gap-4">
                  <p className="text-muted-foreground min-w-0 text-xs">
                    Manage your subscription, payment methods, and invoices.
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    className="shrink-0 gap-1.5"
                    onClick={handleManageSubscription}
                    disabled={createPortalSessionMutation.isPending}
                  >
                    {createPortalSessionMutation.isPending ? (
                      <Loading className="size-4 shrink-0" />
                    ) : null}
                    Manage billing
                  </Button>
                </div>
              </div>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
