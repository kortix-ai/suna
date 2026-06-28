'use client';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import { SectionCard } from '@/components/ui/section-card';
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
import { AlertTriangle } from 'lucide-react';
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
        <Skeleton className="h-32 w-full rounded-2xl" />
        <Skeleton className="h-32 w-full rounded-2xl" />
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTriangle className="h-4 w-4" />
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  const subscription = accountState?.subscription;
  const canPurchaseCredits = subscription?.can_purchase_credits || false;
  const isPerSeat = accountState?.billing_model === 'per_seat';
  const hasActiveSubscription = Boolean(subscription?.subscription_id);
  const subscribedToTeam = isPerSeat && hasActiveSubscription;
  const showTeamCheckout = isBillingEnabled() && !hasActiveSubscription;

  return (
    <div className="space-y-6">
      {showTeamCheckout ? (
        <SectionCard
          title={tI18nHardcoded.raw(
            'autoFeaturesAccountsSettingsBillingTabJsxTextKortixTeam698bb03b',
          )}
          description={tI18nHardcoded.raw(
            'autoFeaturesAccountsSettingsBillingTabJsxTextSubscribeToPut67032571',
          )}
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Button
              onClick={() =>
                openUpgradeDialog({
                  reason: 'subscription_required',
                  accountId: billingAccountId,
                })
              }
              className="shrink-0"
            >
              {tI18nHardcoded.raw(
                'autoFeaturesAccountsSettingsBillingTabJsxTextSubscribeToTeam6a396f73',
              )}
            </Button>
            <Button
              variant="link"
              size="sm"
              className="text-muted-foreground hover:text-foreground"
              onClick={handleManageSubscription}
              disabled={createPortalSessionMutation.isPending}
            >
              {createPortalSessionMutation.isPending ? 'Loading…' : 'Manage billing'}
            </Button>
          </div>
        </SectionCard>
      ) : (
        <>
          {highlight === 'credits' && totalCredits <= 0 && (
            <InfoBanner
              tone="warning"
              icon={AlertTriangle}
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
            <SectionCard
              title={tI18nHardcoded.raw(
                'autoFeaturesAccountsSettingsBillingTabJsxTextAutoTopUp9c42761a',
              )}
              description={tI18nHardcoded.raw(
                'autoFeaturesAccountsSettingsBillingTabJsxTextNeverRunOut4fdb8c3d',
              )}
            >
              <AutoTopupCard fetchSettings showSaveButton />
            </SectionCard>
          )}

          {canPurchaseCredits && (
            <SectionCard
              title={tI18nHardcoded.raw(
                'autoFeaturesAccountsSettingsBillingTabJsxTextBuyCreditsd35e7077',
              )}
              description={tI18nHardcoded.raw(
                'autoFeaturesAccountsSettingsBillingTabJsxTextOneTimeTop22a81cd3',
              )}
            >
              <div className="space-y-3">
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
                          'h-auto flex-col rounded-2xl p-3 text-center',
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
                {purchaseError && (
                  <Alert variant="destructive">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription>{purchaseError}</AlertDescription>
                  </Alert>
                )}
                <Button
                  onClick={handlePurchaseCredits}
                  disabled={isPurchasing || !selectedPackage}
                  className="w-full"
                >
                  {isPurchasing
                    ? 'Processing...'
                    : selectedPackage
                      ? `Buy $${selectedPackage.price} in credits`
                      : 'Select a package'}
                </Button>
              </div>
            </SectionCard>
          )}

          <SectionCard
            title="Billing portal"
            description="Manage your subscription, payment methods, and invoices."
            action={
              <Button
                size="sm"
                variant="outline"
                onClick={handleManageSubscription}
                disabled={createPortalSessionMutation.isPending}
              >
                {createPortalSessionMutation.isPending ? 'Loading...' : 'Manage billing'}
              </Button>
            }
          />
        </>
      )}
    </div>
  );
}
