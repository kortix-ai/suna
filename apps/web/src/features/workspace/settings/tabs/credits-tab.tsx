'use client';

/**
 * The Credits tab — what this account has left, where each part of it came
 * from, what is about to arrive, and what the current period cost.
 *
 * **Why it exists** (Jay, 2026-09-03): "it's difficult to get to know how many
 * credits we still have pending". The balance was reachable only through
 * Account -> Plan, where it is the first card of a pane whose other four
 * blocks are all mutations — change plan, buy credits, open the
 * Stripe portal. Someone who wants a number had to open a checkout surface to
 * read it.
 *
 * **Why the id is `credits`, not `usage`.** `usage` is spent: it is an
 * `ACCOUNT_GRADUATED` key (`settings-tabs.ts`) pointing at
 * `/accounts/<id>?tab=transactions`, and `legacySectionRedirect` resolves that
 * map BEFORE live tabs — a tab under that id would shadow every bookmark to
 * the account page's usage surface. The same split `plan` (not `billing`),
 * `workspace` (not `general`) and `tokens` (not `api-keys`) already make. The
 * word "usage" still reaches this pane through the command palette, which
 * carries it in this tab's keyword bag (`settings-palette-items.ts`).
 *
 * **What is new here, versus the balance card the Plan tab already shows**
 * (`features/billing/account-overview.tsx`):
 *
 * 1. **The composition.** `AccountState.credits` carries several numbers and the
 *    product renders one. `monthly` is the plan's grant, remaining, and it
 *    expires at period end; `extra` is
 *    purchased and never expires. Which bucket a balance sits in decides
 *    whether it survives Friday, so a single total answers the wrong question.
 * 2. **The grant meter.** `tier.monthly_credits` is the recurring grant and
 *    `credits.monthly` is what is left of it, so the difference is what this
 *    period consumed. One bar for one headline fraction — not one bar per row,
 *    which is the shape `account-overview.tsx` deliberately removed.
 * 3. **The period is named.** The Plan card shows three spend figures over an
 *    unnamed span; `usage_this_period` carries the dates, so they are printed.
 *
 * **Buying credits happens here** (Jay, 2026-09-03: "the add credit component
 * will be coming in the credit tab content only, not in the plan row"). The
 * top-up control and auto top-up moved off the Plan pane — the action belongs
 * beside the number it changes, not on a pane about a subscription. Nothing is
 * forked: this mounts the SAME `CreditTopupSection` and `AutoTopupCard` that
 * `/accounts/[id]?tab=billing` mounts, under the same
 * `BillingAccountProvider`, which is what scopes their reads and mutations to
 * THIS account rather than the caller's primary one.
 *
 * Everything else on the pane stays read-only. The subscription and
 * the Stripe portal are the Plan pane's subject and are not duplicated here.
 */

import type { ReactNode } from 'react';

import { HubLink } from '@/features/accounts/hub/account-hub-location';
import { hubTarget } from '@/stores/account-panel-store';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { CreditExpiry } from '@/features/billing/credit-expiry';
import { Skeleton } from '@/components/ui/skeleton';
import { formatUsd } from '@/features/billing/account-overview';
import { TopupControls } from '@/features/billing/topup-controls';
import { useAccountState } from '@/hooks/billing/use-account-state';
import { cn } from '@/lib/utils';
import { BillingAccountProvider } from '@/stores/billing-account-context';
import { type AccountState, canOfferTopup } from '@kortix/sdk';
import { dollarsToCredits, formatCredits, formatUsdAsCredits } from '@kortix/shared';
import { ReceiptIcon } from '@phosphor-icons/react';
import { useLocale, useTranslations } from '@/i18n/use-translations';

import { SettingsTabHeader } from '../settings-tab-header';

// ─── Pure model ─────────────────────────────────────────────────────────────
// Everything below this line down to the components is data, not markup, and
// is exported so it can be tested against a fixed `AccountState` with no API,
// no auth, and no billing flag — the same container/view split
// `account-overview.tsx` and `profile-tab.tsx` use, and for the same reason:
// the shapes worth reviewing (out of credits, negative balance, no grant) cannot be produced locally without provisioning accounts and
// a Stripe subscription.

export interface CreditBucket {
  id: 'monthly' | 'extra';
  label: string;
  /** What happens to this bucket over time. One short clause, not a sentence. */
  hint: string;
  credits: number;
}

export interface CreditBucketCopy {
  monthly: Pick<CreditBucket, 'label' | 'hint'>;
  extra: Pick<CreditBucket, 'label' | 'hint'>;
}

const DEFAULT_BUCKET_COPY: CreditBucketCopy = {
  monthly: { label: 'Plan credits', hint: 'Expire at period end' },
  extra: { label: 'Purchased', hint: 'Never expire' },
};

/**
 * The two buckets that sum to `credits.total`, in the order they are spent
 * down: the grant, then the money you paid.
 *
 * Both always render, including at zero. A strip whose column count
 * depends on the data reflows between accounts and between refreshes, and a
 * zero is itself the answer to "do I have any purchased credits left".
 */
export function creditBuckets(
  state: AccountState,
  copy: CreditBucketCopy = DEFAULT_BUCKET_COPY,
): CreditBucket[] {
  const credits = state.credits;
  return [
    {
      id: 'monthly',
      ...copy.monthly,
      credits: dollarsToCredits(credits?.monthly ?? 0),
    },
    {
      id: 'extra',
      ...copy.extra,
      credits: dollarsToCredits(credits?.extra ?? 0),
    },
  ];
}

export interface GrantMeter {
  usedCredits: number;
  grantedCredits: number;
  /** 0–100, clamped. Feeds `Progress`, which takes a percentage. */
  percent: number;
  /** `ok` under 90% of the grant, `low` from 90%, `spent` at the cap. */
  tone: 'ok' | 'low' | 'spent';
}

/**
 * How much of this period's plan grant is gone.
 *
 * `tier.monthly_credits` is the STORED recurring grant (the API's own comment:
 * Stripe owns it),
 * and `credits.monthly` is what is left of it. Anything the account bought or
 * earned daily sits in a different bucket, so the subtraction stays honest.
 *
 * `null` when the plan grants nothing, where a "0 of 0 used" bar is a bar that
 * can never move.
 */
export function planGrantMeter(state: AccountState): GrantMeter | null {
  const grantedCredits = dollarsToCredits(state.tier?.monthly_credits ?? 0);
  if (grantedCredits <= 0) return null;

  const remaining = dollarsToCredits(state.credits?.monthly ?? 0);
  // Clamped at both ends: a grant that was topped up mid-period can leave
  // `remaining` above `granted`, which would otherwise print negative usage.
  const usedCredits = Math.min(Math.max(grantedCredits - remaining, 0), grantedCredits);
  const percent = Math.min(100, Math.max(0, Math.round((usedCredits / grantedCredits) * 100)));

  return {
    usedCredits,
    grantedCredits,
    percent,
    tone: usedCredits >= grantedCredits ? 'spent' : percent >= 90 ? 'low' : 'ok',
  };
}

/**
 * `Aug 24 – Sep 3` — the span the spend figures cover.
 *
 * No year, for the same reason `account-overview.tsx` drops it from a renewal
 * date: a billing period always lands inside one. An en dash, not a hyphen —
 * this is a range, and the hyphen is a different mark.
 */
export function formatPeriod(
  start: string | null,
  end: string | null,
  locale?: string,
): string | null {
  const from = formatDay(start, locale);
  const to = formatDay(end, locale);
  if (!from || !to) return from ?? to;
  return `${from} – ${to}`;
}

function formatDay(iso: string | null | undefined, locale?: string): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}

// ─── Container ──────────────────────────────────────────────────────────────

export function CreditsTab({ accountId }: { accountId: string | undefined }) {
  const t = useTranslations('settings.credits');
  const accountState = useAccountState({ accountId });

  if (accountState.isLoading || !accountState.data) {
    return (
      <div className="mx-auto w-full max-w-2xl space-y-8">
        <SettingsTabHeader tab="credits" />
        {accountState.isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-40 w-full rounded-md" />
            <Skeleton className="h-24 w-full rounded-md" />
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">{t('loadFailed')}</p>
        )}
      </div>
    );
  }

  const state = accountState.data;

  return (
    // The provider is what scopes `CreditTopupSection` and `AutoTopupCard` to
    // THIS account — both read `useBillingAccountId()` — so a multi-account
    // user cannot top up the wrong wallet from the right pane.
    //
    // `?? null` is the provider's documented "fall back to the user's primary
    // account", which is the same account `useAccountState({ accountId:
    // undefined })` above just read. Passing `undefined` through would be a
    // type error, and coercing it to a string would name the wrong wallet.
    <BillingAccountProvider accountId={accountId ?? null}>
      <div className="mx-auto w-full max-w-2xl space-y-8">
        <SettingsTabHeader tab="credits" />
        <CreditsView
          state={state}
          accountId={accountId}
          // Passed in as a slot rather than rendered inside `CreditsView`:
          // both children are hook-driven, and the view has to stay renderable
          // against a fixed `AccountState` with no query client. Same reason
          // the model above is pure. `canOfferTopup` (the plan may buy credits
          // AND this person may change billing) also decides whether the pane
          // draws the "Add credits" section around the slot at all. A member
          // still reads the whole pane: knowing the balance is not the same as
          // being able to change it.
          topup={canOfferTopup(state) ? <TopupControls state={state} /> : null}
        />
      </div>
    </BillingAccountProvider>
  );
}

// ─── View ───────────────────────────────────────────────────────────────────

/** Presentational only — no hooks, no data fetching, no query client. */
export function CreditsView({
  state,
  accountId,
  topup,
}: {
  state: AccountState;
  accountId?: string;
  /** The Add credits / Auto top-up card, or `null` when this account or this
   *  person may not buy. Injected so the view stays hook-free. */
  topup?: ReactNode;
}) {
  const t = useTranslations('settings.credits');
  const locale = useLocale();
  const balance = state.credits?.total ?? 0;
  const isNegative = balance < 0;
  const buckets = creditBuckets(state, {
    monthly: { label: t('buckets.monthly.label'), hint: t('buckets.monthly.hint') },
    extra: { label: t('buckets.extra.label'), hint: t('buckets.extra.hint') },
  });
  const meter = planGrantMeter(state);
  const usage = state.usage_this_period;
  const period = usage ? formatPeriod(usage.period_start, usage.period_end, locale) : null;

  return (
    <div className="space-y-8">
      {/* The number the tab exists to answer, at the top, at hero scale, with
          the composition under one hairline. No action beside it: "Add
          credits" is a whole card of its own further down, and a button up
          here would be a second door onto the control two sections below —
          the shape that made the balance hard to find in the first place. */}
      <div className="bg-popover rounded-md border">
        <div className="px-4 py-4">
          <div className="min-w-0">
            <p className="text-muted-foreground text-xs">{t('availableBalance')}</p>
            {/* `tabular-nums`, not `font-mono` — the call `account-overview.tsx`
                documents: a monospace face gives ',' a digit's advance and
                opens visible gaps mid-number. Credits are the headline; the
                dollar equivalent is the quiet line under it. */}
            <p
              className={cn(
                'mt-1.5 truncate text-2xl leading-none font-semibold tracking-tight tabular-nums',
                isNegative ? 'text-kortix-red' : 'text-foreground',
              )}
            >
              {formatUsdAsCredits(balance, { locale })}
              <span className="text-muted-foreground ml-1.5 text-sm font-normal tracking-normal">
                {t('unit', { count: Math.abs(balance) * 100 })}
              </span>
            </p>
            <p className="text-muted-foreground mt-1.5 text-xs tabular-nums">
              ≈ {formatUsd(Math.abs(balance), locale)}
              {isNegative ? ` ${t('owed')}` : ''}
            </p>
            {state.credits.monthly > 0 && <CreditExpiry expiresAt={state.credits.expires_at} />}
          </div>
        </div>

        <div className="divide-border grid grid-cols-2 divide-x border-t">
          {buckets.map((bucket) => (
            <div key={bucket.id} className="min-w-0 px-4 py-3">
              <p className="text-muted-foreground truncate text-xs">{bucket.label}</p>
              <p className="text-foreground mt-0.5 truncate text-sm font-medium tabular-nums">
                {formatCredits(bucket.credits, { locale })}
              </p>
              <p className="text-muted-foreground mt-0.5 truncate text-xs">{bucket.hint}</p>
            </div>
          ))}
        </div>
      </div>

      {meter ? (
        <section className="space-y-4">
          <Label>{t('includedInPlan')}</Label>
          {/* One bar, for one headline fraction. `account-overview.tsx` removed
              the per-row bars from Limits because a bar under every row
              restated a fraction the numbers already gave exactly; a single
              meter for the single number that has a ceiling is the case those
              bars were not. */}
          {meter ? (
            <div className="bg-popover rounded-md border px-4 py-4">
              <div className="flex items-baseline justify-between gap-4">
                <span className="text-foreground text-sm font-medium">{t('usedThisPeriod')}</span>
                <span
                  className={cn(
                    'shrink-0 text-sm font-medium tabular-nums',
                    meter.tone === 'spent'
                      ? 'text-kortix-red'
                      : meter.tone === 'low'
                        ? 'text-kortix-orange'
                        : 'text-muted-foreground',
                  )}
                >
                  {formatCredits(meter.usedCredits, { locale })} /{' '}
                  {formatCredits(meter.grantedCredits, { locale })}
                </span>
              </div>
              <Progress
                value={meter.percent}
                className="mt-3 h-1.5"
                indicatorClassName={cn(
                  meter.tone === 'spent'
                    ? 'bg-kortix-red'
                    : meter.tone === 'low'
                      ? 'bg-kortix-orange'
                      : 'bg-primary',
                )}
              />
              <p className="text-muted-foreground mt-2 text-xs tabular-nums">
                {meter.tone === 'spent'
                  ? t('planCreditsSpent')
                  : t('grantRemaining', {
                      count: meter.grantedCredits - meter.usedCredits,
                      formatted: formatCredits(meter.grantedCredits - meter.usedCredits, {
                        locale,
                      }),
                    })}
              </p>
            </div>
          ) : null}
        </section>
      ) : null}

      {topup ? (
        <section className="space-y-4">
          <Label>{t('addCredits')}</Label>
          {topup}
        </section>
      ) : null}

      {usage ? (
        <section className="space-y-4">
          {/* The period is named. The same three figures appear on the Plan
              tab over an unnamed span, which makes "1,130 credits" unreadable
              — since when? `usage_this_period` carries the dates; print them. */}
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <Label>{t('spentThisPeriod')}</Label>
            {period ? (
              <span className="text-muted-foreground text-xs tabular-nums">{period}</span>
            ) : null}
          </div>
          <div className="bg-popover divide-border grid grid-cols-3 divide-x rounded-md border">
            <SpendStat label={t('compute')} value={usage.compute_usd} locale={locale} />
            <SpendStat label="LLM" value={usage.llm_usd} locale={locale} />
            <SpendStat label={t('total')} value={usage.total_usd} locale={locale} strong />
          </div>
        </section>
      ) : null}

      {accountId ? (
        // The same shape as the Billing portal row on the Plan tab: one line
        // saying what is behind the door, one button opening it.
        <section className="space-y-4">
          <Label>{t('history')}</Label>
          <div className="bg-popover rounded-md border px-4 py-3">
            <div className="flex items-center justify-between gap-4">
              <p className="text-muted-foreground min-w-0 text-xs">{t('historyDescription')}</p>
              <Button asChild size="sm" variant="outline" className="shrink-0 gap-1.5">
                <HubLink to={hubTarget(accountId, { tab: 'transactions' })}>
                  <ReceiptIcon className="size-3.5 shrink-0" />
                  {t('openLedger')}
                </HubLink>
              </Button>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function SpendStat({
  label,
  value,
  strong,
  locale,
}: {
  label: string;
  value: number;
  strong?: boolean;
  locale?: string;
}) {
  const t = useTranslations('settings.credits');
  return (
    <div className="min-w-0 px-4 py-3">
      <p className="text-muted-foreground truncate text-xs">{label}</p>
      <p
        className={cn(
          'mt-0.5 text-sm tabular-nums',
          strong ? 'text-foreground font-semibold' : 'text-foreground font-medium',
        )}
      >
        {formatUsdAsCredits(value, { locale })}
        <span className="text-muted-foreground ml-1 text-xs font-normal">
          {t('unit', { count: Math.abs(value) * 100 })}
        </span>
      </p>
    </div>
  );
}
