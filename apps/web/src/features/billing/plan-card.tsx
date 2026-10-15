'use client';

/**
 * The plan card: the subscription at hero scale, and the control that changes
 * it.
 *
 * The plan is the subject. The Credits pane (`settings/tabs/credits-tab.tsx`)
 * owns the wallet: balance, composition, period spend. This card names the
 * plan, says where it stands (renews, cancels, past due), and, for an account
 * owner, lets them pick a new tier with the same `CreditTierSelect` the pricing
 * page and the upgrade modal use.
 *
 * There are no seats. Members are unlimited and share one credit pool, so the
 * only thing a person can change is the tier.
 */

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import {
  DEFAULT_TIER_USD,
  FREE_MONTHLY_CREDITS,
  formatWholeUsd,
  isValidMonthlyUsd,
  monthlyCreditsForUsd,
  tierForMonthlyUsd,
} from '@/features/billing/compute-pricing';
import { CreditTierSelect } from '@/features/billing/credit-tier-select';
import { useChangeCreditPlan } from '@/features/billing/use-change-credit-plan';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { accountHasLiveSubscription } from '@/lib/billing/billing-gate-state';
import { isBillingEnabled } from '@/lib/config';
import { cn } from '@/lib/utils';
import { canManageBilling, resolvedPlan, type AccountState } from '@kortix/sdk';
import { formatCredits } from '@kortix/shared';
import { useState } from 'react';

import { describePlanStatus } from './account-overview';

export type PlanChangeKind = 'subscribe' | 'raise' | 'cut' | 'unchanged' | 'invalid';

/**
 * What choosing `nextUsd` does, given the account's live subscription.
 * The API decides the outcome; this only says it before the click, in the
 * same terms (`POST /v1/billing/plan`): no paid subscription starts Stripe
 * Checkout, a raise is charged now, a cut waits for the next renewal.
 */
export function describePlanChange(opts: {
  currentUsd: number | null;
  nextUsd: number | null;
  hasSubscription: boolean;
}): PlanChangeKind {
  if (!isValidMonthlyUsd(opts.nextUsd) || !tierForMonthlyUsd(opts.nextUsd)) return 'invalid';
  if (!opts.hasSubscription) return 'subscribe';
  if (opts.currentUsd === null || opts.nextUsd > opts.currentUsd) return 'raise';
  if (opts.nextUsd < opts.currentUsd) return 'cut';
  return 'unchanged';
}

/** Monthly credits the account's current plan grants, or `null` when it grants
 *  a fixed amount that is not a purchase (Enterprise contracts). */
function currentPlanCredits(state: AccountState): number | null {
  const plan = resolvedPlan(state);
  if (plan.monthlyUsd != null) return monthlyCreditsForUsd(plan.monthlyUsd);
  if (plan.family === 'free') return FREE_MONTHLY_CREDITS;
  return null;
}

export function PlanCard({ state }: { state: AccountState }) {
  const t = useTranslations('billing.plan');
  const tCredits = useTranslations('billing.credits');
  const locale = useLocale();
  const planCopy = {
    locale,
    perMonth: (amount: string) => t('perMonth', { amount }),
    cancels: (date: string) => t('cancels', { date }),
    cancelsAtPeriodEnd: t('cancelsAtPeriodEnd'),
    renews: (date: string) => t('renews', { date }),
    active: t('active'),
    noSubscription: t('noSubscription'),
    trialDaysLeft: (days: number) => t('trialDaysLeft', { days }),
    trialEndsToday: t('trialEndsToday'),
    ends: (date: string) => t('ends', { date }),
    annualContract: t('annualContract'),
    graceUntil: (date: string) => t('graceUntil', { date }),
    status: (status: string) =>
      t.has(`statuses.${status}`)
        ? t(`statuses.${status}`)
        : t('status', { status: status.replace(/_/g, ' ') }),
  };
  const { name, sublabel, detail, isActive, isWindingDown } = describePlanStatus(state, planCopy);
  const credits = currentPlanCredits(state);

  return (
    <div className="bg-popover rounded-md border">
      {/* Same geometry as the balance card on the Credits pane — label, hero
          line, qualifier, with the status opposite it — so hopping between the
          two sibling panes does not move the eye. `items-center`: the left
          block is taller than the right, and top-aligning them reads as a
          diagonal rather than a row. */}
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-4">
        <div className="min-w-0">
          <p className="text-muted-foreground text-xs">{t('currentPlan')}</p>
          <p className="text-foreground mt-1.5 truncate text-2xl leading-none font-semibold tracking-tight">
            {name}
          </p>
          {sublabel || credits !== null ? (
            <p className="text-muted-foreground mt-1.5 truncate text-xs tabular-nums">
              {[
                sublabel,
                credits !== null
                  ? tCredits('tiers.creditsPerMonth', {
                      credits: formatCredits(credits, { locale }),
                    })
                  : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          ) : null}
        </div>
        <span className="flex min-w-0 shrink-0 items-center gap-1.5">
          {isActive ? (
            // Optical, not geometric: a 6px dot centred on a 20px line box
            // sits a hair high against the x-height of the text beside it.
            <span
              aria-hidden
              className={cn(
                'mt-px size-1.5 shrink-0 rounded-full',
                isWindingDown ? 'bg-kortix-orange' : 'bg-kortix-green',
              )}
            />
          ) : null}
          <span className="text-muted-foreground truncate text-xs leading-5 first-letter:capitalize">
            {detail}
          </span>
        </span>
      </div>

      <PlanChanger state={state} className="border-t" />
    </div>
  );
}

/**
 * Pick a monthly amount and apply it. Renders nothing when billing is off, for
 * an Enterprise contract (managed with the account team), and shows who to ask
 * to anyone who may not change billing.
 */
export function PlanChanger({ state, className }: { state: AccountState; className?: string }) {
  const t = useTranslations('billing.credits.planCard');
  const locale = useLocale();
  const plan = resolvedPlan(state);
  const currentUsd = plan.monthlyUsd ?? null;
  const hasSubscription = accountHasLiveSubscription(state);
  // An off-ladder current amount (a legacy $20 plan) opens on the select's
  // "choose a tier" state; everyone else opens on their tier or the popular one.
  const [monthlyUsd, setMonthlyUsd] = useState<number | null>(
    currentUsd ?? (hasSubscription ? null : DEFAULT_TIER_USD),
  );
  const { change, isPending } = useChangeCreditPlan();

  if (!isBillingEnabled()) return null;
  if (plan.family === 'enterprise') {
    return (
      <p className={cn('text-muted-foreground px-4 py-3 text-xs', className)}>
        {t('enterpriseNote')}
      </p>
    );
  }
  if (!canManageBilling(state)) {
    return (
      <p className={cn('text-muted-foreground px-4 py-3 text-xs', className)}>{t('ownerOnly')}</p>
    );
  }

  const kind = describePlanChange({ currentUsd, nextUsd: monthlyUsd, hasSubscription });
  const amount = monthlyUsd !== null ? formatWholeUsd(monthlyUsd, locale) : '';
  const hint = kind === 'raise' ? t('raiseHint') : kind === 'cut' ? t('cutHint') : t('rate');
  const label =
    kind === 'subscribe'
      ? t('subscribeAction', { amount })
      : kind === 'raise' || kind === 'cut'
        ? t('updateAction', { amount })
        : t('chooseAction');

  return (
    <section className={cn('space-y-3 px-4 py-4', className)}>
      <div className="space-y-0.5">
        <h3 className="text-foreground text-sm font-medium">{t('title')}</h3>
        <p className="text-muted-foreground text-xs">{t('description')}</p>
      </div>
      <CreditTierSelect
        value={monthlyUsd}
        onChange={setMonthlyUsd}
        current={currentUsd}
        disabled={isPending}
      />
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="text-muted-foreground min-w-0 flex-1 text-xs text-balance">{hint}</p>
        <Button
          size="sm"
          className="gap-1.5"
          disabled={isPending || kind === 'invalid' || kind === 'unchanged'}
          onClick={() => monthlyUsd !== null && change(monthlyUsd)}
        >
          {isPending ? <Loading className="size-4 shrink-0" /> : null}
          {label}
        </Button>
      </div>
    </section>
  );
}
