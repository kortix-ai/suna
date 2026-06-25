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
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { PricingPlanCard } from '@/features/billing/pricing-plan-card';
import { UPGRADE_MODAL_PLANS, type UpgradeModalPlanId } from '@/features/billing/pricing-plans';
import { useAccountState, useCreatePerSeatCheckout } from '@/hooks/billing';
import type { AccountState } from '@/lib/api/billing';
import { BillingAccountProvider } from '@/stores/billing-account-context';
import { useUpgradeDialogStore } from '@/stores/upgrade-dialog-store';
import { ArrowRight, UserPlus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';

export interface UpgradePlansModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountState?: AccountState;
}

export function UpgradePlansModal({ open, onOpenChange, accountState }: UpgradePlansModalProps) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const createPerSeat = useCreatePerSeatCheckout();

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

  const planBadges: Partial<Record<UpgradeModalPlanId, string>> = {
    free: 'Current plan',
  };

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
            Simple per-seat pricing. Free includes 500 credits each month for sandbox compute;
            upgrade when you want managed models and 2,000 pooled usage credits per seat.
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
            <Link href="/enterprise" className="text-foreground underline-offset-4 hover:underline">
              Contact sales
            </Link>
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

export function GlobalUpgradeModal() {
  const { isOpen, closeUpgradeDialog, accountId } = useUpgradeDialogStore();
  const { data: accountState } = useAccountState({ accountId });

  return (
    <BillingAccountProvider accountId={accountId ?? null}>
      <UpgradePlansModal
        open={isOpen}
        onOpenChange={(open) => !open && closeUpgradeDialog()}
        accountState={accountState}
      />
    </BillingAccountProvider>
  );
}
