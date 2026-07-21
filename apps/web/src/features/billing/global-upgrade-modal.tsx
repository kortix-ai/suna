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
import { AutoTopupCard } from '@/features/billing/auto-topup-card';
import { CreditTopupSection } from '@/features/billing/credit-topup-section';
import { PricingPlanCard } from '@/features/billing/pricing-plan-card';
import { UPGRADE_MODAL_PLANS, type UpgradeModalPlanId } from '@/features/billing/pricing-plans';
import { useRequestDemo } from '@/features/contact/request-demo-provider';
import { useAccountState, useCreatePerSeatCheckout, useCreatePortalSession } from '@/hooks/billing';
import type { AccountState } from '@/lib/api/billing';
import { cn } from '@/lib/utils';
import { BillingAccountProvider } from '@/stores/billing-account-context';
import { useUpgradeDialogStore } from '@/stores/upgrade-dialog-store';
import { formatCredits } from '@kortix/shared';
import { ArrowRight, CreditCard, UserPlus } from 'lucide-react';
import { useTranslations } from 'next-intl';

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
}

export function UpgradePlansModal({
  open,
  onOpenChange,
  accountState,
  reason,
  billingModel,
  hasSubscription,
  balance,
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
}

/**
 * The out-of-credits view of the blocking modal: a clear "why you're blocked"
 * header + wallet balance, one-time top-up (packages + custom amount), and
 * auto-top-up config underneath so a drained Team account can both refill now
 * and never hit zero again — instead of being wrongly pitched the Free plan.
 */
function CreditTopUpModal({ open, onOpenChange, accountState, balance }: CreditTopUpModalProps) {
  const createPortal = useCreatePortalSession();
  const walletUsd = balance ?? accountState?.credits?.total ?? 0;
  const isNegative = walletUsd < 0;
  const walletLabel = `${walletUsd < 0 ? '-' : ''}$${Math.abs(walletUsd).toFixed(2)}`;
  const creditsLabel = formatCredits(Math.round(Math.abs(walletUsd) * 100));

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="gap-0 space-y-0 p-0 lg:max-w-lg">
        <ModalHeader className="space-y-2 px-6 pt-6 pb-4">
          <div className="flex items-center gap-2">
            <span className="bg-kortix-orange/10 text-kortix-orange flex size-9 items-center justify-center rounded-full">
              <CreditCard className="size-4" />
            </span>
            <ModalTitle className="text-xl font-medium tracking-tight">Out of credits</ModalTitle>
          </div>
          <ModalDescription className="text-sm">
            Your agents are paused because the wallet is empty. Top up to keep compute and the
            latest AI models running — your Team plan and seats are unaffected.
          </ModalDescription>
        </ModalHeader>

        <ModalBody className="space-y-5 px-6 pb-2">
          {/* Wallet balance — the concrete "why" behind the block. */}
          <div className="bg-popover flex items-center justify-between rounded-md border px-4 py-3">
            <span className="text-muted-foreground text-sm">Wallet balance</span>
            <span
              className={cn(
                'text-lg font-medium tabular-nums',
                isNegative ? 'text-kortix-red' : 'text-foreground',
              )}
            >
              {walletLabel}
              {isNegative && (
                <span className="text-muted-foreground ml-1.5 text-xs">
                  ({creditsLabel} credits owed)
                </span>
              )}
            </span>
          </div>

          <div className="space-y-3">
            <Label>Buy credits</Label>
            <CreditTopupSection />
          </div>

          {/* Auto top-up underneath — configure it here so it never happens again. */}
          <div className="space-y-3">
            <Label>Auto top-up</Label>
            <div className="bg-popover rounded-md border px-4 py-4">
              <AutoTopupCard fetchSettings showSaveButton />
            </div>
          </div>
        </ModalBody>

        <ModalFooter className="px-6 pb-6 pt-2">
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
  const { data: accountState } = useAccountState({ accountId });

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
      />
    </BillingAccountProvider>
  );
}
