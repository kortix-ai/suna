'use client';

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@/components/ui/item';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { Skeleton } from '@/components/ui/skeleton';
import { AutoTopupCard } from '@/features/billing/auto-topup-card';
import { CreditTopupSection } from '@/features/billing/credit-topup-section';
import { PricingPlanCard } from '@/features/billing/pricing-plan-card';
import { UPGRADE_MODAL_PLANS, type UpgradeModalPlanId } from '@/features/billing/pricing-plans';
import { useRequestDemo } from '@/features/contact/request-demo-provider';
import {
  invalidateAccountState,
  useAccountState,
  useCreatePerSeatCheckout,
  useCreatePortalSession,
} from '@/hooks/billing';
import type { AccountState } from '@/lib/api/billing';
import { cn } from '@/lib/utils';
import { BillingAccountProvider } from '@/stores/billing-account-context';
import { useUpgradeDialogStore } from '@/stores/upgrade-dialog-store';
import { formatCredits } from '@kortix/shared';
import { CreditCardPlusSolid } from '@mynaui/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, UserPlus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect } from 'react';

export interface UpgradePlansModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountState?: AccountState;
  /** From the 402: distinguishes "Team wallet drained → top up" (credit view)
   *  from "no plan → subscribe" (plans view). Fall back to accountState. */
  reason?: string;
  billingModel?: string;
  hasSubscription?: boolean;
  balance?: number;
  /** True while account state is doing its first load — the credit view shows a
   *  balance skeleton instead of a misleading $0.00 until the real value lands. */
  accountLoading?: boolean;
}

export function UpgradePlansModal({
  open,
  onOpenChange,
  accountState,
  reason,
  billingModel,
  hasSubscription,
  balance,
  accountLoading,
}: UpgradePlansModalProps) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const createPerSeat = useCreatePerSeatCheckout();
  const openDemo = useRequestDemo();

  // Show the top-up view (not the Free-plan pitch) whenever we can tell the
  // account is already a paying/Team account whose wallet ran dry. Prefer the
  // 402 hints (billing_model / has_subscription / reason) since accountState can
  // still be loading when the modal opens; fall back to it once available.
  const isPerSeat = billingModel === 'per_seat' || accountState?.billing_model === 'per_seat';
  const hasSub = hasSubscription ?? Boolean(accountState?.subscription?.subscription_id);
  const canPurchaseCredits = accountState?.tier?.can_purchase_credits ?? isPerSeat;
  const showTopUp =
    (reason === 'insufficient_credits' || isPerSeat || hasSub) && canPurchaseCredits;

  if (showTopUp) {
    return (
      <CreditTopUpModal
        open={open}
        onOpenChange={onOpenChange}
        accountState={accountState}
        balance={balance}
        accountLoading={accountLoading}
      />
    );
  }

  const pricePerSeat = accountState?.seats?.price_per_seat_usd ?? 40;
  const seatCount = Math.max(1, accountState?.member_count ?? accountState?.seats?.count ?? 1);
  const monthlyTotal = pricePerSeat * seatCount;
  const hasSeatMath = seatCount > 1;
  const canManageBilling = accountState?.can_manage_billing !== false;

  const handleSubscribe = () => {
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    createPerSeat.mutate({
      success_url: `${origin}/projects?team_signup=success`,
      cancel_url: typeof window !== 'undefined' ? window.location.href : `${origin}/`,
    });
  };

  const planActions: Record<UpgradeModalPlanId, React.ReactNode> = {
    free: (
      <Button
        type="button"
        variant="outline"
        className="w-full"
        onClick={() => onOpenChange(false)}
      >
        Continue on Free
      </Button>
    ),
    team: canManageBilling ? (
      <div className="space-y-2">
        {hasSeatMath && (
          <p className="text-muted-foreground text-center text-xs tabular-nums">
            {seatCount} {seatCount === 1 ? 'seat' : 'seats'} × ${pricePerSeat} = ${monthlyTotal}/mo
          </p>
        )}
        <Button
          type="button"
          variant="default"
          className="group w-full"
          disabled={createPerSeat.isPending}
          onClick={handleSubscribe}
        >
          {createPerSeat.isPending ? (
            <>
              <Loading />
              {tI18nHardcoded.raw(
                'autoFeaturesBillingTeamPlanCheckoutJsxTextStartingCheckout282edf7f',
              )}
            </>
          ) : (
            <>
              {hasSeatMath
                ? `Subscribe — $${monthlyTotal}/mo`
                : `Subscribe — $${pricePerSeat}/seat`}
              <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
            </>
          )}
        </Button>
        <p className="text-muted-foreground text-center text-xs">
          {tI18nHardcoded.raw(
            'autoFeaturesBillingTeamPlanCheckoutJsxTextAutoProratedCancelfa091962',
          )}
        </p>
      </div>
    ) : (
      <Button type="button" variant="outline" className="w-full" disabled>
        Owner subscription required
      </Button>
    ),
  };

  // Badge the plan the account is ACTUALLY on, computed from account state —
  // never hardcoded to Free (that mislabels every paying account as Free, the
  // core bug here). The top-up view already handles per-seat/subscribed
  // accounts, so this plans view is only reached for free/no-plan accounts.
  const planBadges: Partial<Record<UpgradeModalPlanId, string>> = isPerSeat
    ? { team: 'Current plan' }
    : { free: 'Current plan' };

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="gap-0 space-y-0 p-0 lg:max-w-3xl">
        <ModalHeader className="space-y-2 px-6 pt-6 pb-4">
          <ModalTitle className="text-2xl font-medium tracking-tight">
            {tI18nHardcoded.raw(
              'autoFeaturesBillingTeamPlanCheckoutJsxTextSubscribeToKortix28a9093d',
            )}
          </ModalTitle>
          <ModalDescription className="text-base">
            Simple per-seat pricing. Free includes 200 credits each month for sandbox compute;
            upgrade when you want the latest AI models and 2,500 pooled credits per seat.
          </ModalDescription>
        </ModalHeader>

        <ModalBody className="space-y-4 px-6 pb-6">
          <div className="grid gap-4 md:grid-cols-2">
            {UPGRADE_MODAL_PLANS.map((plan) => (
              <PricingPlanCard
                key={plan.id}
                plan={plan}
                compact
                action={planActions[plan.id]}
                badgeOverride={planBadges[plan.id]}
                priceOverride={plan.id === 'team' ? `$${pricePerSeat}` : undefined}
              />
            ))}
          </div>

          <p className="text-muted-foreground text-center text-xs">
            Need SSO, on-prem, or volume pricing?{' '}
            <button
              type="button"
              onClick={() => {
                onOpenChange(false);
                openDemo({ source: 'billing-upgrade-modal' });
              }}
              className="text-foreground underline-offset-4 hover:underline"
            >
              Contact sales
            </button>
          </p>

          {!canManageBilling && (
            <Item variant="outline" size="sm" className="items-start bg-none">
              <Hint
                label={tI18nHardcoded.raw(
                  'autoFeaturesBillingTeamPlanCheckoutJsxAttrLabelOnlyAccountbf72d3e0',
                )}
                side="top"
                className="max-w-xs text-xs"
              >
                <ItemMedia variant="icon">
                  <UserPlus />
                </ItemMedia>
              </Hint>
              <ItemContent>
                <ItemTitle>
                  {tI18nHardcoded.raw(
                    'autoFeaturesBillingTeamPlanCheckoutJsxTextAskAnAccount6f6b506d',
                  )}
                </ItemTitle>
                <ItemDescription className="text-xs leading-relaxed">
                  {tI18nHardcoded.raw(
                    'autoFeaturesBillingTeamPlanCheckoutJsxTextOnlyAccountOwnerse7f0d952',
                  )}
                </ItemDescription>
              </ItemContent>
            </Item>
          )}
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}

interface CreditTopUpModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountState?: AccountState;
  balance?: number;
  accountLoading?: boolean;
}

/**
 * The out-of-credits view of the blocking modal: a clear "why you're blocked"
 * header + wallet balance, one-time top-up (packages + custom amount), and
 * auto-top-up config underneath so a drained Team account can both refill now
 * and never hit zero again — instead of being wrongly pitched the Free plan.
 */
function CreditTopUpModal({
  open,
  onOpenChange,
  accountState,
  balance,
  accountLoading,
}: CreditTopUpModalProps) {
  const createPortal = useCreatePortalSession();

  // Trust the LIVE account state as the source of truth (same field the Plan
  // page reads) — the 402's `balance` is only a pre-load hint. Using `??` on the
  // live value would let a legitimate 0 fall through; instead branch on whether
  // it's loaded so a real $0.00 shows as $0.00 and an unloaded value shows a
  // skeleton — never a misleading $0.00 while the real (e.g. negative) balance
  // is still in flight.
  const liveBalance = accountState?.credits?.total;
  const hasLiveBalance = typeof liveBalance === 'number';
  const walletUsd = hasLiveBalance ? liveBalance : (balance ?? 0);
  const showBalanceSkeleton = !hasLiveBalance && accountLoading;
  const isNegative = walletUsd < 0;
  const walletLabel = `${isNegative ? '-' : ''}$${Math.abs(walletUsd).toFixed(2)}`;
  const creditsLabel = formatCredits(Math.round(Math.abs(walletUsd) * 100));

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="lg:max-w-lg">
        <ModalHeader className="gap-3">
          <div className="flex items-center gap-3">
            <span className="bg-kortix-orange/15 flex size-9 shrink-0 items-center justify-center rounded-sm">
              <CreditCardPlusSolid className="text-kortix-orange size-5" />
            </span>
            <div className="space-y-0.5">
              <ModalTitle className="text-lg font-medium tracking-tight">Out of credits</ModalTitle>
              <ModalDescription className="text-sm text-balance">
                Top up to keep compute and the latest AI models running — your Team plan and seats
                are unaffected.
              </ModalDescription>
            </div>
          </div>
        </ModalHeader>

        <ModalBody className="space-y-6 pt-4">
          {/* Wallet balance — the concrete "why" behind the block. */}
          <div className="bg-popover flex items-center justify-between gap-3 rounded-md border px-4 py-3">
            <span className="text-muted-foreground text-sm">Wallet balance</span>
            {showBalanceSkeleton ? (
              <Skeleton className="h-6 w-24 rounded-md" />
            ) : (
              <span className="flex items-baseline gap-1.5">
                <span
                  className={cn(
                    'text-lg font-medium tabular-nums',
                    isNegative ? 'text-kortix-red' : 'text-foreground',
                  )}
                >
                  {walletLabel}
                </span>
                {isNegative && (
                  <span className="text-muted-foreground text-xs tabular-nums">
                    {creditsLabel} owed
                  </span>
                )}
              </span>
            )}
          </div>

          <section className="space-y-3">
            <Label>Buy credits</Label>
            <CreditTopupSection />
          </section>

          {/* Auto top-up underneath — configure it here so it never happens again. */}
          <section className="space-y-3">
            <Label>Auto top-up</Label>
            <div className="bg-popover rounded-md border px-4 py-4">
              <AutoTopupCard fetchSettings showSaveButton />
            </div>
          </section>
        </ModalBody>

        <ModalFooter className="pt-4 pb-5 sm:justify-start">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground gap-1.5"
            disabled={createPortal.isPending}
            onClick={() => createPortal.mutate({ return_url: window.location.href })}
          >
            {createPortal.isPending ? <Loading className="size-4 shrink-0" /> : null}
            Manage billing
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

export function GlobalUpgradeModal() {
  const { isOpen, closeUpgradeDialog, accountId, reason, billingModel, hasSubscription, balance } =
    useUpgradeDialogStore();
  const { data: accountState, isLoading: accountLoading } = useAccountState({ accountId });
  const queryClient = useQueryClient();

  // Pull the freshest wallet balance every time the modal opens (skip the
  // server cache) so it always matches the Plan page — never a stale/zero value
  // left over from an earlier read, and it reflects a top-up the moment it lands.
  useEffect(() => {
    if (isOpen) invalidateAccountState(queryClient, true, true, accountId);
  }, [isOpen, queryClient, accountId]);

  return (
    <BillingAccountProvider accountId={accountId ?? null}>
      <UpgradePlansModal
        open={isOpen}
        onOpenChange={(open) => !open && closeUpgradeDialog()}
        accountState={accountState}
        reason={reason}
        billingModel={billingModel}
        hasSubscription={hasSubscription}
        balance={balance}
        accountLoading={accountLoading}
      />
    </BillingAccountProvider>
  );
}
