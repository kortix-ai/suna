'use client';

import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast } from '@/components/ui/toast';
import { AccountOverviewTab } from '@/features/billing/account-overview';
import { AutoTopupCard } from '@/features/billing/auto-topup-card';
import { ClaimPerSeatCard } from '@/features/billing/claim-per-seat-card';
import { SeatManagementCard } from '@/features/billing/seat-management-card';
import { useAuth } from '@/features/providers/auth-provider';
import {
  accountStateKeys,
  accountStateSelectors,
  invalidateAccountState,
  useCreatePortalSession,
} from '@/hooks/billing';
import { AccountState, billingApi } from '@/lib/api/billing';
import { isBillingEnabled } from '@/lib/config';
import { cn } from '@/lib/utils';
import { useBillingAccountId } from '@/stores/billing-account-context';
import { useUpgradeDialogStore } from '@/stores/upgrade-dialog-store';
import { useUserSettingsModalStore } from '@/stores/user-settings-modal-store';
import { formatCredits } from '@kortix/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';

const CREDIT_PACKAGES: { credits: number; price: number }[] = [
  { credits: 1000, price: 10 },
  { credits: 2500, price: 25 },
  { credits: 5000, price: 50 },
  { credits: 10000, price: 100 },
  { credits: 25000, price: 250 },
  { credits: 50000, price: 500 },
];

export function BillingTab({ returnUrl, isActive }: { returnUrl: string; isActive: boolean }) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const { session, isLoading: authLoading } = useAuth();
  const highlight = useUserSettingsModalStore((s) => s.highlight);
  const openUpgradeDialog = useUpgradeDialogStore((s) => s.openUpgradeDialog);
  const [selectedPackage, setSelectedPackage] = useState<(typeof CREDIT_PACKAGES)[number] | null>(
    null,
  );
  const [isPurchasing, setIsPurchasing] = useState(false);
  const [purchaseError, setPurchaseError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const billingAccountId = useBillingAccountId();

  const {
    data: accountState,
    isLoading: isLoadingSubscription,
    error: subscriptionError,
  } = useQuery<AccountState>({
    queryKey: accountStateKeys.state(billingAccountId),
    queryFn: () => billingApi.getAccountState(false, billingAccountId),
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

  const handlePurchaseCredits = async () => {
    if (!selectedPackage) return;
    setIsPurchasing(true);
    setPurchaseError(null);
    try {
      const response = await billingApi.purchaseCredits(
        {
          amount: selectedPackage.price,
          success_url: `${window.location.origin}/dashboard?credit_purchase=success`,
          cancel_url: window.location.href,
        },
        billingAccountId,
      );
      if (response.checkout_url) {
        window.location.href = response.checkout_url;
      } else {
        throw new Error('No checkout URL received');
      }
    } catch (err: unknown) {
      const error = err as { details?: { detail?: string }; message?: string };
      const msg = error?.details?.detail || error?.message || 'Failed to create checkout session';
      setPurchaseError(msg);
      errorToast(msg);
    } finally {
      setIsPurchasing(false);
    }
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
          {highlight === 'credits' && totalCredits <= 0 && (
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

          <AccountOverviewTab accountId={billingAccountId} />

          {accountState?.can_claim_per_seat && <ClaimPerSeatCard accountState={accountState} />}

          {subscribedToTeam && <SeatManagementCard accountState={accountState} />}

          {canPurchaseCredits && (
            <section className="space-y-4">
              <div className="space-y-1">
                <Label>Auto top-up</Label>
                <p className="text-muted-foreground text-xs">
                  {tI18nHardcoded.raw(
                    'autoFeaturesAccountsSettingsBillingTabJsxTextNeverRunOut4fdb8c3d',
                  )}
                </p>
              </div>
              <div className="bg-popover rounded-md border px-4 py-5">
                <AutoTopupCard fetchSettings showSaveButton />
              </div>
            </section>
          )}

          {canPurchaseCredits && (
            <section className="space-y-4">
              <div className="space-y-1">
                <Label>Buy credits</Label>
                <p className="text-muted-foreground text-xs">
                  {tI18nHardcoded.raw(
                    'autoFeaturesAccountsSettingsBillingTabJsxTextOneTimeTop22a81cd3',
                  )}
                </p>
              </div>
              <div className="bg-popover space-y-3 rounded-md border px-4 py-5">
                <div className="grid grid-cols-3 gap-2">
                  {CREDIT_PACKAGES.map((pkg) => {
                    const isSelected = selectedPackage?.price === pkg.price;
                    return (
                      <Button
                        key={pkg.price}
                        type="button"
                        onClick={() => setSelectedPackage(pkg)}
                        disabled={isPurchasing}
                        variant="outline"
                        className={cn(
                          'h-auto flex-col rounded-md p-3 text-center',
                          isSelected && 'border-primary bg-primary/[0.06]',
                        )}
                      >
                        <span className="text-lg font-semibold tabular-nums">${pkg.price}</span>
                        <span className="text-muted-foreground text-xs">
                          {formatCredits(pkg.credits)} credits
                        </span>
                      </Button>
                    );
                  })}
                </div>
                {purchaseError && <InfoBanner tone="destructive">{purchaseError}</InfoBanner>}
                <Button
                  onClick={handlePurchaseCredits}
                  disabled={isPurchasing || !selectedPackage}
                  className="w-full gap-1.5"
                >
                  {isPurchasing ? <Loading className="size-4 shrink-0" /> : null}
                  {isPurchasing
                    ? 'Processing'
                    : selectedPackage
                      ? `Buy $${selectedPackage.price} in credits`
                      : 'Select a package'}
                </Button>
              </div>
            </section>
          )}

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
        </>
      )}
    </div>
  );
}
