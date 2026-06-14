'use client';

import { AccountOverviewTab } from '@/components/billing/account-overview';
import { AutoTopupCard } from '@/components/billing/auto-topup-card';
import { ClaimPerSeatCard } from '@/components/billing/claim-per-seat-card';
import { SeatManagementCard } from '@/components/billing/seat-management-card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { InfoBanner } from '@/components/ui/info-banner';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast } from '@/components/ui/toast';
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
import { AlertTriangle, Zap } from 'lucide-react';
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
      <div className="max-w-full min-w-0 space-y-5 overflow-x-hidden p-4 sm:space-y-6 sm:p-6">
        <Skeleton className="h-8 w-32" />
        <div className="space-y-4">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-full min-w-0 overflow-x-hidden p-4 sm:p-6">
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      </div>
    );
  }

  const subscription = accountState?.subscription;
  const canPurchaseCredits = subscription?.can_purchase_credits || false;
  const isPerSeat = accountState?.billing_model === 'per_seat';
  const hasActiveSubscription = Boolean(subscription?.subscription_id);
  const subscribedToTeam = isPerSeat && hasActiveSubscription;
  const showTeamCheckout = isBillingEnabled() && !hasActiveSubscription;

  return (
    <div className="scrollbar-hide w-full max-w-full min-w-0 space-y-6 overflow-x-hidden px-6 py-5">
      {showTeamCheckout ? (
        <>
          <Card className="gap-4">
            <CardHeader>
              <CardTitle>Kortix Team</CardTitle>
              <CardDescription>
                Subscribe to put your whole team on Kortix — LLM compute and AI Computers, one
                wallet.
              </CardDescription>
            </CardHeader>
            <CardFooter>
              <Button
                onClick={() =>
                  openUpgradeDialog({
                    reason: 'subscription_required',
                    accountId: billingAccountId,
                  })
                }
                className="w-full shrink-0 sm:w-auto"
              >
                Subscribe to Team plan
              </Button>
            </CardFooter>
          </Card>
          <div className="flex justify-center">
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
        </>
      ) : (
        <>
          {highlight === 'credits' && totalCredits <= 0 && (
            <InfoBanner tone="warning" icon={AlertTriangle} title="You ran out of credits">
              {canPurchaseCredits
                ? 'Buy credits below or turn on auto top-up so it never happens again.'
                : 'Top up your wallet to keep your agents running.'}
            </InfoBanner>
          )}

          <AccountOverviewTab accountId={billingAccountId} />

          {accountState?.can_claim_per_seat && <ClaimPerSeatCard accountState={accountState} />}

          {subscribedToTeam && <SeatManagementCard accountState={accountState} />}

          {canPurchaseCredits && (
            <div className="border-border space-y-3 border-t pt-4">
              <div className="flex items-center justify-between">
                <p className="text-muted-foreground flex items-center gap-1.5 text-xs tracking-widest uppercase">
                  <Zap className="size-3" />
                  Auto top-up
                </p>
                <p className="text-muted-foreground/60 text-xs">Never run out again</p>
              </div>
              <AutoTopupCard fetchSettings showSaveButton />
            </div>
          )}

          {canPurchaseCredits && (
            <div className="border-border space-y-3 border-t pt-4">
              <div className="flex items-center justify-between">
                <p className="text-muted-foreground text-xs tracking-widest uppercase">
                  Buy credits
                </p>
                <p className="text-muted-foreground/60 text-xs">One-time top-up</p>
              </div>
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
                        isSelected && 'border-foreground bg-foreground/5',
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
          )}

          <div className="border-border border-t pt-4">
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs"
              onClick={handleManageSubscription}
              disabled={createPortalSessionMutation.isPending}
            >
              {createPortalSessionMutation.isPending ? 'Loading...' : 'Manage billing'}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
