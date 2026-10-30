'use client';

import { Button } from '@kortix/ui/button';
import Hint from '@kortix/ui/hint';
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@kortix/ui/item';
import Loading from '@kortix/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@kortix/ui/modal';
import { Skeleton } from '@kortix/ui/skeleton';
import { DEFAULT_TIER_USD, formatWholeUsd, tierForMonthlyUsd } from '@kortix/ui/internal/billing/compute-pricing';
import { CreditTierSelect } from '@/features/billing/credit-tier-select';
import { PlanChanger } from '@/features/billing/plan-card';
import { PricingPlanCard } from '@/features/billing/pricing-plan-card';
import type { PricingPlan } from '@/features/billing/pricing-plans';
import { TopupControls } from '@/features/billing/topup-controls';
import { useChangeCreditPlan } from '@/features/billing/use-change-credit-plan';
import { useUpgradePlans } from '@/features/billing/use-pricing-plans';
import { useUpgradeModalHost } from '@/features/billing/use-upgrade-modal-host';
import { useTalkToSales } from '@/features/billing/use-enterprise-sales';
import { invalidateAccountState, useAccountState, useCreatePortalSession } from '@kortix/ui/internal/billing/index';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import {
  accountHasLiveSubscription,
  billingModalCopy,
  billingStateNeedsTopUp,
  resolveBillingState,
} from '@kortix/ui/internal/lib/billing/billing-gate-state';
import { cn } from '@kortix/ui';
import { BillingAccountProvider, useBillingAccountId } from '@kortix/ui/internal/stores/billing-account-context';
import { useUpgradeDialogStore } from '@kortix/ui/internal/stores/upgrade-dialog-store';
import { type AccountState, type BillingState, canManageBilling } from '@kortix/sdk';
import { formatUsdAsCredits } from '@kortix/shared';
import { ArrowRightIcon as ArrowRight, UserPlusIcon as UserPlus } from '@phosphor-icons/react';
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
   *  balance skeleton instead of a misleading 0 until the real value lands. */
  accountLoading?: boolean;
}

/**
 * Which view the billing modal opens on:
 *
 * - `plans`: Free against Credits, for an account that cannot buy credits yet;
 * - `topup-first`: out of credits or payment failed, so the top-up is the question;
 * - `plan-first`: an account that can buy credits and is not blocked. The
 *   monthly plan leads; the top-up is the secondary section.
 */
export function billingModalLayout(opts: {
  needsTopUp: boolean;
  hasSubscription: boolean;
  canPurchaseCredits: boolean;
}): 'plans' | 'topup-first' | 'plan-first' {
  if (!opts.canPurchaseCredits || !(opts.needsTopUp || opts.hasSubscription)) return 'plans';
  return opts.needsTopUp ? 'topup-first' : 'plan-first';
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
  const sales = useTalkToSales(useBillingAccountId());

  // Which view? Resolved from the ONE billing-state resolver. The caller's
  // `billingState` (from the 402 or the gate that opened this) wins because
  // accountState can still be loading; otherwise derive it from live state.
  const hasSub = hasSubscription ?? accountHasLiveSubscription(accountState);
  const canPurchaseCredits = accountState?.tier?.can_purchase_credits ?? hasSub;
  const resolvedState = billingState ?? resolveBillingState(accountState);
  const layout = billingModalLayout({
    needsTopUp: billingStateNeedsTopUp(resolvedState) || reason === 'insufficient_credits',
    hasSubscription: hasSub,
    canPurchaseCredits,
  });

  if (layout !== 'plans') {
    return (
      <CreditTopUpModal
        open={open}
        onOpenChange={onOpenChange}
        accountState={accountState}
        balance={balance}
        billingState={resolvedState}
        accountLoading={accountLoading}
        leadWithTopUp={layout === 'topup-first'}
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
              disabled={sales.isPending}
              onClick={sales.talk}
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
  /** Out of credits or payment failed: the top-up leads, with the balance. */
  leadWithTopUp: boolean;
}

/**
 * The plan and top-up view, for an account that can buy credits. Two orders:
 *
 * - out of credits (`leadWithTopUp`): why the account is blocked, the balance,
 *   the one-time top-up, then the monthly plan as the other way out;
 * - otherwise: the monthly plan first, and the top-up below as a quieter
 *   "need more this month" section.
 *
 * Auto top-up stays folded inside `TopupControls` in both.
 */
function CreditTopUpModal({
  open,
  onOpenChange,
  accountState,
  balance,
  billingState,
  accountLoading,
  leadWithTopUp,
}: CreditTopUpModalProps) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const tBanner = useTranslations('hardcodedUi.componentsSessionSessionErrorBanner');
  const t = useTranslations('billing.credits.modal');
  const createPortal = useCreatePortalSession();
  // Out-of-credits copy is DERIVED from the billing state, never written here:
  // a hardcoded "Out of credits" title once announced an emergency to every
  // account that opened this modal.
  const copy = leadWithTopUp
    ? billingModalCopy(billingState ?? null, tI18nComplete)
    : { title: t('planTitle'), description: t('planDescription') };

  const topup = (
    <TopupControls
      state={accountState}
      heading={
        leadWithTopUp ? (
          tI18nComplete.raw('textd22feb61298b')
        ) : (
          <span className="text-muted-foreground font-normal">{t('topupSecondary')}</span>
        )
      }
      // KRTX-1720: buying credits needs `billing.write`; the API answers a
      // member 403. A member is told who can act. Nothing renders a purchase
      // control before the account state says who this is.
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
  );
  const plan = accountState ? (
    <PlanChanger state={accountState} className="bg-popover rounded-md border" />
  ) : null;

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="lg:max-w-lg">
        <ModalHeader className="gap-1">
          <ModalTitle className="text-lg font-medium tracking-tight">{copy.title}</ModalTitle>
          <ModalDescription className="text-sm text-balance">{copy.description}</ModalDescription>
        </ModalHeader>

        <ModalBody className="space-y-4 pt-4">
          {leadWithTopUp ? (
            <>
              <WalletBalance
                accountState={accountState}
                balance={balance}
                accountLoading={accountLoading}
              />
              {topup}
              {plan}
            </>
          ) : (
            <>
              {plan}
              {topup}
            </>
          )}
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

/**
 * The available balance, in credits: the concrete "why" behind an
 * out-of-credits block.
 *
 * The LIVE account state is the source of truth (the field the Plan page
 * reads); the 402's `balance` is only a pre-load hint. A real 0 shows as 0,
 * and an unloaded value shows a skeleton, never a misleading 0. A negative
 * balance keeps its minus and turns red: the account owes those credits.
 */
function WalletBalance({
  accountState,
  balance,
  accountLoading,
}: {
  accountState?: AccountState;
  balance?: number;
  accountLoading?: boolean;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const tCredits = useTranslations('settings.credits');
  const locale = useLocale();
  const liveBalance = accountState?.credits?.total;
  const hasLiveBalance = typeof liveBalance === 'number';
  const walletUsd = hasLiveBalance ? liveBalance : (balance ?? 0);
  const isNegative = walletUsd < 0;

  return (
    <div className="bg-popover flex items-center justify-between gap-3 rounded-md border px-4 py-3">
      <span className="text-muted-foreground text-sm">{tI18nComplete.raw('text3ab7dd8428d1')}</span>
      {!hasLiveBalance && accountLoading ? (
        <Skeleton className="h-6 w-24 rounded-md" />
      ) : (
        <span className="flex items-baseline gap-1.5">
          <span
            className={cn(
              'text-lg font-medium tabular-nums',
              isNegative ? 'text-kortix-red' : 'text-foreground',
            )}
          >
            {formatUsdAsCredits(walletUsd, { locale })}
          </span>
          <span className="text-muted-foreground text-xs">
            {tCredits('unit', { count: Math.abs(walletUsd) * 100 })}
          </span>
        </span>
      )}
    </div>
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
