'use client';

/**
 * The account overview block at the top of the Billing tab: what you can
 * spend, what plan you are on, what you spent this period, and the limits
 * that plan enforces.
 *
 * **Restyle (2026-08-13).** This used to render three separate labelled
 * sections — "Plan" (a two-up of two bordered cards), "Spend this period" (a
 * bordered divided table), and "Limits" (a bordered panel of progress bars) —
 * inside a tab that then wrapped the whole thing in a fourth "Plan, wallet and
 * spend" heading. Five headings and four boxes to say three numbers. Jay's
 * brief: less crowded, less nesting, no jargon.
 *
 * What it renders now:
 *
 * 1. **One balance card.** The number you actually came here for is the
 *    largest thing on the pane — available balance, with its credit
 *    equivalent under it — and the plan sits opposite it as a quiet right-hand
 *    column (plan name, then status or renewal date). A hairline splits off a
 *    three-column strip for this period's spend: Compute, LLM, Total. That
 *    strip replaces the old bordered spend table entirely.
 * 2. **One limits group**, only when the API reports limits. Hairline rows,
 *    `active / limit` right-aligned, red at the cap. The progress bars are
 *    gone: a bar under every row tripled the block's height to restate a
 *    fraction the numbers already give exactly.
 *
 * Wording: "wallet" → "Available balance", and the "Sandbox runtime" /
 * "Inference" hints under Compute and LLM are dropped — they explained the
 * words to nobody who did not already know them.
 */

import { Skeleton } from '@/components/ui/skeleton';
import { useAccountState } from '@/hooks/billing/use-account-state';
import { cn } from '@/lib/utils';
import { resolvedPlan, type AccountState } from '@kortix/sdk';
import { dollarsToCredits, formatCredits } from '@kortix/shared';

type LimitRow = {
  id: string;
  label: string;
  active: number;
  limit: number;
};

interface AccountOverviewTabProps {
  /** Scope the balance/limits/spend display to a specific account.
   *  Required on /accounts/[id]; omit on global surfaces. */
  accountId?: string;
}

/** Container: owns the account-state read, renders the view. */
export function AccountOverviewTab({ accountId }: AccountOverviewTabProps = {}) {
  const accountState = useAccountState({ accountId });

  if (accountState.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-[9.5rem] w-full rounded-md" />
        <Skeleton className="h-28 w-full rounded-md" />
      </div>
    );
  }

  const state = accountState.data;
  if (!state) {
    return <p className="text-muted-foreground text-sm">Couldn&apos;t load this account.</p>;
  }

  return <AccountOverviewView state={state} />;
}

/**
 * Presentational only — no hooks, no data fetching, no query client. The same
 * container/view split `billing-tab.tsx` and `profile-tab.tsx` use, and for
 * the same reason: the shapes worth reviewing (per-seat, out of credits,
 * negative balance) cannot be produced locally without provisioning three
 * accounts and a Stripe subscription, so the view has to be renderable against
 * a fixed `AccountState` with no API, no auth, and no billing flag.
 */
export function AccountOverviewView({ state }: { state: AccountState }) {
  const wallet = state.credits?.total ?? 0;
  const isNegative = wallet < 0;
  const usage = state.usage_this_period;
  const limits = buildLimitRows(state.limits);

  return (
    <div className="space-y-4">
      {/* Balance + plan, then this period's spend under one hairline.
          `items-center`, not `items-start`: the left block is three lines tall
          and the right one is two, so top-aligning them pinned the plan to the
          ceiling with the balance hanging below it — a diagonal, not a row.
          Centred, the plan sits opposite the number it qualifies. */}
      <div className="bg-popover rounded-md border">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-4">
          <div className="min-w-0">
            <p className="text-muted-foreground text-xs">Available balance</p>
            {/* `tabular-nums`, deliberately NOT `font-mono`. Tabular figures
                give the equal-width digits a balance wants; a monospace face
                gives the '.' and ',' the same advance as a '0' too, which
                opens visible gaps mid-number ("$99891 . 85") and reads as
                broken kerning next to the grouped credits line below. */}
            <p
              className={cn(
                'mt-1.5 truncate text-2xl leading-none font-semibold tracking-tight tabular-nums',
                isNegative ? 'text-kortix-red' : 'text-foreground',
              )}
            >
              {formatUsd(wallet)}
            </p>
            <p className="text-muted-foreground mt-1.5 text-xs tabular-nums">
              {formatCredits(dollarsToCredits(Math.abs(wallet)))} credits
              {isNegative ? ' owed' : ''}
            </p>
          </div>
          <PlanSummary state={state} />
        </div>

        {usage ? (
          <div className="divide-border grid grid-cols-3 divide-x border-t">
            <SpendStat label="Compute" value={usage.compute_usd} />
            <SpendStat label="LLM" value={usage.llm_usd} />
            <SpendStat label="Spent this period" value={usage.total_usd} strong />
          </div>
        ) : null}
      </div>

      {limits.length > 0 ? (
        <section className="space-y-2">
          <h3 className="text-foreground text-sm font-medium">Limits</h3>
          <div className="bg-popover divide-border divide-y rounded-md border">
            {limits.map((row) => {
              const atCap = row.limit > 0 && row.active >= row.limit;
              return (
                <div
                  key={row.id}
                  className="flex items-center justify-between gap-4 px-4 py-2.5 text-sm"
                >
                  <span className="text-foreground min-w-0 truncate">{row.label}</span>
                  <span
                    className={cn(
                      'shrink-0 font-medium tabular-nums',
                      atCap ? 'text-kortix-red' : 'text-muted-foreground',
                    )}
                  >
                    {row.active} / {row.limit}
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}
    </div>
  );
}

/** The right-hand column of the balance card: plan name, then the one line
 *  that says where that plan stands — renewal date when there is a live
 *  subscription, status otherwise. Per-seat accounts name the seat count,
 *  which no plan label carries. */
function PlanSummary({ state }: { state: AccountState }) {
  const seatCount = state.seats?.count ?? 1;
  const plan = resolvedPlan(state);
  const isPerSeat = state.billing_model === 'per_seat';
  const name = isPerSeat ? `Team · ${seatCount} seat${seatCount === 1 ? '' : 's'}` : plan.label;
  const sublabel = isPerSeat ? null : plan.sublabel;

  const sub = state.subscription;
  const periodEnd = sub?.current_period_end ? formatDate(sub.current_period_end) : null;
  const isActive = sub?.status === 'active';

  const detail = sub?.cancel_at_period_end
    ? periodEnd
      ? `Cancels ${periodEnd}`
      : 'Cancels at period end'
    : isActive && periodEnd
      ? `Renews ${periodEnd}`
      : isActive
        ? 'Active'
        : // Raw Stripe statuses are snake_case ('past_due', 'incomplete_expired').
          // Shown to a person, so they read as words.
          (sub?.status?.replace(/_/g, ' ') ?? 'No subscription');

  return (
    // Right-aligned beside the balance; left-aligned once the row wraps under
    // it on a narrow pane, where a right-aligned block below a left-aligned
    // one has nothing to align to.
    <div className="flex min-w-0 shrink-0 flex-col items-start gap-0.5 text-left sm:items-end sm:text-right">
      <span className="flex items-center gap-1.5">
        {isActive ? (
          // Optical, not geometric: a 6px dot centred on a 20px line box sits
          // a hair high against the x-height of the text beside it.
          <span
            aria-hidden
            className={cn(
              'mt-px size-1.5 shrink-0 rounded-full',
              sub?.cancel_at_period_end ? 'bg-kortix-orange' : 'bg-kortix-green',
            )}
          />
        ) : null}
        <span className="text-foreground truncate text-sm leading-5 font-medium">{name}</span>
      </span>
      {sublabel ? <span className="text-muted-foreground text-xs">{sublabel}</span> : null}
      <span className="text-muted-foreground text-xs first-letter:capitalize">{detail}</span>
    </div>
  );
}

function SpendStat({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  return (
    <div className="min-w-0 px-4 py-3">
      <p className="text-muted-foreground truncate text-xs">{label}</p>
      {/* Same call as the balance above: tabular figures, not `font-mono`.
          Mixing a monospace strip under a proportional balance would make one
          card read in two typefaces. See the note on the balance. */}
      <p
        className={cn(
          'mt-0.5 text-sm tabular-nums',
          strong ? 'text-foreground font-semibold' : 'text-foreground font-medium',
        )}
      >
        {formatUsd(value)}
      </p>
    </div>
  );
}

function buildLimitRows(
  limits: NonNullable<ReturnType<typeof useAccountState>['data']>['limits'],
): LimitRow[] {
  if (!limits) return [];
  const rows: LimitRow[] = [];
  if (limits.concurrent_sessions) {
    rows.push({
      id: 'sessions',
      label: 'Concurrent sessions',
      active: limits.concurrent_sessions.active,
      limit: limits.concurrent_sessions.limit,
    });
  }
  if (limits.concurrent_runs) {
    rows.push({
      id: 'runs',
      label: 'Concurrent agent runs',
      active: limits.concurrent_runs.running_count,
      limit: limits.concurrent_runs.limit,
    });
  }
  if (limits.ai_worker_count) {
    rows.push({
      id: 'workers',
      label: 'AI workers',
      active: limits.ai_worker_count.current_count,
      limit: limits.ai_worker_count.limit,
    });
  }
  if (limits.custom_mcp_count) {
    rows.push({
      id: 'mcps',
      label: 'Custom MCP connectors',
      active: limits.custom_mcp_count.current_count,
      limit: limits.custom_mcp_count.limit,
    });
  }
  return rows;
}

/**
 * `$99,891.85` — grouped, two decimals, minus before the symbol (`-$3.20`).
 *
 * It used to be `` `$${n.toFixed(2)}` ``, which printed `$99891.85`: no
 * thousands separator, so a five-figure balance had to be counted digit by
 * digit — and it sat directly above a credit line that `formatCredits` has
 * always grouped, so one card showed the same quantity two ways.
 *
 * `style: 'currency'` rather than hand-assembling the string: it is the same
 * call `session-cost-format.ts` already makes, and it is what puts the minus
 * outside the dollar sign instead of producing `$-3.20`. `en-US` is hardcoded
 * to match `formatCredits`
 * (`packages/shared/src/utils/credit-formatter.ts`) — two separators
 * disagreeing inside one card is worse than either choice alone.
 */
export function formatUsd(amount: number | null | undefined): string {
  const n = typeof amount === 'number' && Number.isFinite(amount) ? amount : 0;
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** `Sep 19` — no year, because a billing period always lands inside one. */
function formatDate(unixSeconds: number): string | null {
  const ms = unixSeconds * 1000;
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
