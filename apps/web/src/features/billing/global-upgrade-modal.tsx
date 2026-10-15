'use client';

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@/components/ui/item';
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
import { DEFAULT_TIER_USD, formatWholeUsd, tierForMonthlyUsd } from '@/features/billing/compute-pricing';
import { CreditTierSelect } from '@/features/billing/credit-tier-select';
import { PlanChanger } from '@/features/billing/plan-card';
import { PricingPlanCard } from '@/features/billing/pricing-plan-card';
import type { PricingPlan } from '@/features/billing/pricing-plans';
import { TopupControls } from '@/features/billing/topup-controls';
import { useChangeCreditPlan } from '@/features/billing/use-change-credit-plan';
import { useUpgradePlans } from '@/features/billing/use-pricing-plans';
import { useUpgradeModalHost } from '@/features/billing/use-upgrade-modal-host';
import { useRequestDemo } from '@/features/contact/request-demo-provider';
import { invalidateAccountState, useAccountState, useCreatePortalSession } from '@/hooks/billing';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import {
  accountHasLiveSubscription,
  billingModalCopy,
  billingStateNeedsTopUp,
  resolveBillingState,
} from '@/lib/billing/billing-gate-state';
import { cn } from '@/lib/utils';
import { BillingAccountProvider } from '@/stores/billing-account-context';
import { useUpgradeDialogStore } from '@/stores/upgrade-dialog-store';
import { type AccountState, type BillingState, canManageBilling } from '@kortix/sdk';
import { formatCredits } from '@kortix/shared';
import {
  ArrowRightIcon as ArrowRight,
  CreditCardIcon as CreditCardPlusSolid,
  UserPlusIcon as UserPlus,
} from '@phosphor-icons/react';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

export interface UpgradePlansModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountState?: AccountState;
  /** From the 402: distinguishes "wallet drained → top up" (credit view)
   *  from "no plan → pick a plan" (plans view). Fall back to accountState. */
  reason?: string;
  hasSubscription?: boolean;
  /** The resolved state from whichever surface opened the modal. Preferred over
   *  `reason` (the lossy 402 code) so the modal and the gate that opened it can
   *  never disagree about the same account. */
  billingState?: BillingState;
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
  hasSubscription,
  billingState,
  balance,
  accountLoading,
}: UpgradePlansModalProps) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const t = useTranslations('billing.credits.modal');
  const plans = useUpgradePlans();
  const openDemo = useRequestDemo();

  // Which view? Resolved from the ONE billing-state resolver. The caller's
  // `billingState` (from the 402 or the gate that opened this) wins because
  // accountState can still be loading; otherwise derive it from live state.
  const hasSub = hasSubscription ?? accountHasLiveSubscription(accountState);
  const canPurchaseCredits = accountState?.tier?.can_purchase_credits ?? hasSub;
  const resolvedState = billingState ?? resolveBillingState(accountState);
  const showTopUp =
    (billingStateNeedsTopUp(resolvedState) || reason === 'insufficient_credits' || hasSub) &&
    canPurchaseCredits;

  if (showTopUp) {
    return (
      <CreditTopUpModal
        open={open}
        onOpenChange={onOpenChange}
        accountState={accountState}
        balance={balance}
        billingState={resolvedState}
        accountLoading={accountLoading}
      />
    );
  }

  // `false` until the account state loads (KRTX-1720): Subscribe stays
  // disabled for that window, and the "owner required" button and the "ask an
  // owner" note wait for the answer.
  const mayManageBilling = canManageBilling(accountState);
  const ownerRequired = !!accountState && !mayManageBilling;

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="gap-0 space-y-0 p-0 lg:max-w-3xl">
        <ModalHeader className="space-y-2 px-6 pt-6 pb-4">
          <ModalTitle className="text-2xl font-medium tracking-tight">{t('title')}</ModalTitle>
          <ModalDescription className="text-base">{t('description')}</ModalDescription>
        </ModalHeader>

        <ModalBody className="space-y-4 px-6 pb-6">
          <div className="grid gap-4 md:grid-cols-2">
            {plans.map((plan) => (
              <UpgradePlanCard
                key={plan.id}
                plan={plan}
                onContinueFree={() => onOpenChange(false)}
                ownerRequired={ownerRequired}
                mayManageBilling={mayManageBilling}
              />
            ))}
          </div>

          <p className="text-muted-foreground text-center text-xs">
            {tI18nHardcoded.raw('i18nComplete.textff2b8e88c520')}{' '}
            <button
              type="button"
              onClick={() => {
                onOpenChange(false);
                openDemo({ source: 'billing-upgrade-modal' });
              }}
              className="text-foreground underline-offset-4 hover:underline"
            >
              {tI18nHardcoded.raw('i18nComplete.text604abea32b49')}
            </button>
          </p>

          {ownerRequired && (
            <Item variant="outline" size="sm" className="items-start bg-none">
              <Hint label={t('askOwnerHint')} side="top" className="max-w-xs text-xs">
                <ItemMedia variant="icon">
                  <UserPlus />
                </ItemMedia>
              </Hint>
              <ItemContent>
                <ItemTitle>{t('askOwnerTitle')}</ItemTitle>
                <ItemDescription className="text-xs leading-relaxed">
                  {t('askOwnerBody')}
                </ItemDescription>
              </ItemContent>
            </Item>
          )}
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}

/**
 * One card of the plan view. Free closes the dialog. Credits carries the
 * shared tier select and starts the plan change; its own state, so the tier
 * survives re-renders of the modal.
 */
function UpgradePlanCard({
  plan,
  onContinueFree,
  ownerRequired,
  mayManageBilling,
}: {
  plan: PricingPlan;
  onContinueFree: () => void;
  ownerRequired: boolean;
  mayManageBilling: boolean;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const tAccess = useTranslations('billing.access');
  const tCard = useTranslations('billing.credits.planCard');
  const tPlan = useTranslations('billing.plan');
  const locale = useLocale();
  const [monthlyUsd, setMonthlyUsd] = useState<number>(DEFAULT_TIER_USD);
  const { change, isPending } = useChangeCreditPlan();

  if (plan.id !== 'credits') {
    return (
      <PricingPlanCard
        plan={plan}
        compact
        badgeOverride={tPlan('currentPlan')}
        action={
          <Button type="button" variant="outline" className="w-full" onClick={onContinueFree}>
            {tI18nHardcoded.raw('i18nComplete.text73a7da68c3bf')}
          </Button>
        }
      />
    );
  }

  const valid = !!tierForMonthlyUsd(monthlyUsd);
  return (
    <PricingPlanCard
      plan={plan}
      compact
      priceSlot={
        <div className="space-y-3">
          <CreditTierSelect value={monthlyUsd} onChange={setMonthlyUsd} disabled={isPending} />
          <p className="text-muted-foreground text-xs text-balance">{tCard('rate')}</p>
        </div>
      }
      action={
        ownerRequired ? (
          <Button type="button" variant="outline" className="w-full" disabled>
            {tAccess('managerRequired')}
          </Button>
        ) : (
          <Button
            type="button"
            variant="default"
            className="group w-full"
            disabled={isPending || !mayManageBilling || !valid}
            onClick={() => valid && change(monthlyUsd)}
          >
            {isPending ? (
              <>
                <Loading />
                {tI18nHardcoded.raw(
                  'autoFeaturesBillingTeamPlanCheckoutJsxTextStartingCheckout282edf7f',
                )}
              </>
            ) : (
              <>
                {valid
                  ? tCard('subscribeAction', { amount: formatWholeUsd(monthlyUsd, locale) })
                  : tCard('chooseAction')}
                <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
              </>
            )}
          </Button>
        )
      }
    />
  );
}

interface CreditTopUpModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountState?: AccountState;
  balance?: number;
  billingState?: BillingState | null;
  accountLoading?: boolean;
}

/**
 * The out-of-credits view of the blocking modal: a clear "why you're blocked"
 * header + wallet balance, one-time top-up (packages + custom amount), and
 * auto-top-up config underneath so a drained paid account can both refill now
 * and never hit zero again — instead of being wrongly pitched the Free plan.
 */
function CreditTopUpModal({
  open,
  onOpenChange,
  accountState,
  balance,
  billingState,
  accountLoading,
}: CreditTopUpModalProps) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const tBanner = useTranslations('hardcodedUi.componentsSessionSessionErrorBanner');
  const createPortal = useCreatePortalSession();
  // Copy is DERIVED, never written here. The title used to be hardcoded
  // `'Out of credits'` with a single `payment_failed` branch, so this modal
  // announced an emergency to every account that opened it — including one
  // topping up voluntarily with a healthy balance — and promised "your plan
  // is unaffected" to accounts that had none.
  const copy = billingModalCopy(billingState ?? null, tI18nComplete);

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
              <ModalTitle className="text-lg font-medium tracking-tight">{copy.title}</ModalTitle>
              <ModalDescription className="text-sm text-balance">
                {copy.description}
              </ModalDescription>
            </div>
          </div>
        </ModalHeader>

        <ModalBody className="space-y-4 pt-4">
          {/* Available balance — the concrete "why" behind the block. */}
          <div className="bg-popover flex items-center justify-between gap-3 rounded-md border px-4 py-3">
            <span className="text-muted-foreground text-sm">
              {tI18nComplete.raw('text3ab7dd8428d1')}
            </span>
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
                    {creditsLabel} {tI18nComplete.raw('text4fef65587333')}
                  </span>
                )}
              </span>
            )}
          </div>

          {/* The same card the Billing tab and the Credits pane render, so
              the modal and the panes are not two dialects of one control.
              KRTX-1720: buying credits and auto top-up need `billing.write`
              (owners by default); the API answers a member 403. A member is
              told who can act. Nothing renders a purchase control before the
              account state says who this is. */}
          <TopupControls
            state={accountState}
            heading={tI18nComplete.raw('textd22feb61298b')}
            fallback={
              accountState ? (
                canManageBilling(accountState) ? null : (
                  <p className="text-muted-foreground text-sm" data-testid="topup-ask-owner">
                    {tBanner.raw('askOwnerToAddCredits')}
                  </p>
                )
              ) : accountLoading ? (
                <Skeleton className="h-40 w-full rounded-md" />
              ) : null
            }
          />

          {/* Out of credits on a paid plan: raising the monthly amount is the
              other way out, so the same picker the Plan tab uses sits under
              the one-time top-up. Owners only; PlanChanger says who to ask. */}
          {accountState ? (
            <PlanChanger state={accountState} className="bg-popover rounded-md border" />
          ) : null}
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
            {tI18nComplete.raw('text7ea27c63aff1')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

export function GlobalUpgradeModal() {
  const selected = useUpgradeModalHost();
  return selected ? <GlobalUpgradeModalContent /> : null;
}

function GlobalUpgradeModalContent() {
  const { isOpen, closeUpgradeDialog, accountId, reason, hasSubscription, billingState, balance } =
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
        hasSubscription={hasSubscription}
        billingState={billingState}
        balance={balance}
        accountLoading={accountLoading}
      />
    </BillingAccountProvider>
  );
}
