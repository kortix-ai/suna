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

import { Button } from '@kortix/ui/button';
import Loading from '@kortix/ui/loading';
import {
  DEFAULT_TIER_USD,
  FREE_MONTHLY_CREDITS,
  formatWholeUsd,
  isValidMonthlyUsd,
  monthlyCreditsForUsd,
  tierForMonthlyUsd,
} from '@kortix/ui/internal/billing/compute-pricing';
import { CreditExpiry } from '@/features/billing/credit-expiry';
import { CreditTierSelect } from '@/features/billing/credit-tier-select';
import { useChangeCreditPlan } from '@/features/billing/use-change-credit-plan';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { accountHasLiveSubscription } from '@kortix/ui/internal/lib/billing/billing-gate-state';
import { isBillingEnabled } from '@/lib/config';
import { cn } from '@kortix/ui';
import { useBillingAccountId } from '@kortix/ui/internal/stores/billing-account-context';
import { canManageBilling, resolvedPlan, type AccountState } from '@kortix/sdk';
import { useBillingPlanPreview } from '@kortix/sdk/react';
import { formatCredits } from '@kortix/shared';
import { useState } from 'react';

import { describePlanStatus } from './account-overview';

export type PlanChangeKind = 'subscribe' | 'raise' | 'cut' | 'keep' | 'unchanged' | 'invalid';

/**
 * What choosing `nextUsd` does, given the account's live subscription.
 * The API decides the outcome; this only says it before the click, in the
 * same terms (`POST /v1/billing/plan`): no paid subscription starts Stripe
 * Checkout, a raise is instant (charged now, prorated), a cut waits for the
 * next renewal, and the amount in effect again keeps the plan when a cut is
 * scheduled. `currentUsd` is the amount in effect this period.
 */
export function describePlanChange(opts: {
  currentUsd: number | null;
  nextUsd: number | null;
  hasSubscription: boolean;
  /** A lower amount already scheduled for the next renewal. */
  scheduledUsd?: number | null;
}): PlanChangeKind {
  if (!isValidMonthlyUsd(opts.nextUsd) || !tierForMonthlyUsd(opts.nextUsd)) return 'invalid';
  if (!opts.hasSubscription) return 'subscribe';
  if (opts.currentUsd === null || opts.nextUsd > opts.currentUsd) return 'raise';
  const scheduled = opts.scheduledUsd ?? null;
  if (opts.nextUsd === opts.currentUsd) return scheduled === null ? 'unchanged' : 'keep';
  return opts.nextUsd === scheduled ? 'unchanged' : 'cut';
}

/** A lower credits amount waiting for the next renewal, from the account state. */
export function scheduledDowngrade(
  state: AccountState,
): { monthlyUsd: number; effectiveAt: string } | null {
  const change = state.subscription?.scheduled_change;
  const monthlyUsd = change?.target_tier?.monthly_usd;
  if (!change || change.target_tier.name !== 'credits' || monthlyUsd == null) return null;
  return { monthlyUsd, effectiveAt: change.effective_date };
}

function formatShortDate(iso: string | null | undefined, locale: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}

/** A charge due now: cents matter here, unlike the whole-dollar plan prices. */
function formatChargeUsd(amount: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(amount);
}

/** Monthly credits the account's current plan grants, or `null` when unknown. */
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
          {state.credits.monthly > 0 && <CreditExpiry expiresAt={state.credits.expires_at} />}
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

export interface PlanPickerView {
  /** The monthly amount the account pays, or null when it pays none. */
  currentUsd: number | null;
  /** The amount the picker opens on. */
  initialUsd: number | null;
}

/**
 * What the plan picker opens on: the amount the account pays, or the default
 * tier. Enterprise never changes the billing plan, so every account gets the
 * picker. A live subscription on an amount the API does not report (an
 * off-ladder legacy price) opens on the select's "choose a tier" state.
 */
export function planPickerView(state: AccountState): PlanPickerView {
  const currentUsd = resolvedPlan(state).monthlyUsd ?? state.subscription?.monthly_usd ?? null;
  const initialUsd = currentUsd ?? (accountHasLiveSubscription(state) ? null : DEFAULT_TIER_USD);
  return { currentUsd, initialUsd };
}

/**
 * Pick a monthly amount and apply it. Renders nothing when billing is off, and
 * shows who to ask to anyone who may not change billing.
 */
export function PlanChanger({ state, className }: { state: AccountState; className?: string }) {
  const t = useTranslations('billing.credits.planCard');
  const locale = useLocale();
  const { currentUsd, initialUsd } = planPickerView(state);
  const hasSubscription = accountHasLiveSubscription(state);
  const scheduled = scheduledDowngrade(state);
  const [monthlyUsd, setMonthlyUsd] = useState<number | null>(initialUsd);
  const { change, isPending } = useChangeCreditPlan();
  const billingAccountId = useBillingAccountId();
  const kind = describePlanChange({
    currentUsd,
    nextUsd: monthlyUsd,
    hasSubscription,
    scheduledUsd: scheduled?.monthlyUsd,
  });
  // Only a raise needs the server: the charge due now is Stripe's proration.
  const preview = useBillingPlanPreview({
    monthlyUsd: kind === 'raise' && isBillingEnabled() ? monthlyUsd : null,
    accountId: billingAccountId ?? undefined,
  });

  if (!isBillingEnabled()) return null;
  if (!canManageBilling(state)) {
    return (
      <p className={cn('text-muted-foreground px-4 py-3 text-xs', className)}>{t('ownerOnly')}</p>
    );
  }

  const amount = monthlyUsd !== null ? formatWholeUsd(monthlyUsd, locale) : '';
  const renewal = formatShortDate(
    scheduled?.effectiveAt ??
      (state.subscription?.current_period_end
        ? new Date(state.subscription.current_period_end * 1000).toISOString()
        : null),
    locale,
  );
  const due = preview.data ? formatChargeUsd(preview.data.due_now_usd, locale) : null;
  const creditsNow = preview.data ? formatCredits(preview.data.credits_now, { locale }) : null;

  const hint =
    kind === 'raise'
      ? due && creditsNow
        ? t('raiseSummary', { due, credits: creditsNow, amount })
        : t('raiseSummaryLoading')
      : kind === 'cut'
        ? renewal
          ? t('cutSummary', { date: renewal, amount })
          : t('cutHint')
        : kind === 'keep' && scheduled
          ? t('keepSummary', { amount: formatWholeUsd(scheduled.monthlyUsd, locale) })
          : kind === 'subscribe'
            ? t('subscribeSummary', {
                amount,
                credits: formatCredits(monthlyCreditsForUsd(monthlyUsd ?? 0), { locale }),
              })
            : t('rate');
  const label =
    kind === 'subscribe'
      ? t('subscribeAction', { amount })
      : kind === 'raise'
        ? due
          ? t('raiseAction', { due })
          : t('updateAction', { amount })
        : kind === 'cut'
          ? renewal
            ? t('cutAction', { date: renewal })
            : t('updateAction', { amount })
          : kind === 'keep'
            ? t('keepAction')
            : t('chooseAction');

  return (
    <section className={cn('space-y-3 px-4 py-4', className)}>
      <div className="space-y-0.5">
        <h3 className="text-foreground text-sm font-medium">{t('title')}</h3>
        <p className="text-muted-foreground text-xs">{t('description')}</p>
      </div>
      {scheduled ? (
        <div className="bg-muted flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-md px-3 py-2">
          <p className="text-foreground min-w-0 flex-1 text-xs">
            {t('scheduledNotice', {
              amount: formatWholeUsd(scheduled.monthlyUsd, locale),
              date: formatShortDate(scheduled.effectiveAt, locale),
            })}
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={isPending || currentUsd === null}
            onClick={() => currentUsd !== null && change(currentUsd)}
          >
            {t('keepAction')}
          </Button>
        </div>
      ) : null}
      <CreditTierSelect
        value={monthlyUsd}
        onChange={setMonthlyUsd}
        current={currentUsd}
        disabled={isPending}
      />
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="text-muted-foreground min-w-0 flex-1 text-xs text-balance" aria-live="polite">
          {hint}
        </p>
        <Button
          size="sm"
          className="gap-1.5"
          disabled={
            isPending ||
            kind === 'invalid' ||
            kind === 'unchanged' ||
            (kind === 'raise' && preview.isLoading)
          }
          onClick={() => monthlyUsd !== null && change(monthlyUsd)}
        >
          {isPending ? <Loading className="size-4 shrink-0" /> : null}
          {label}
        </Button>
      </div>
    </section>
  );
}
