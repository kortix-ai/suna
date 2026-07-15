'use client';

import { useTranslations } from 'next-intl';
// Account overview block — rendered at the top of the Billing tab.
// One-glance read of plan + this-period spend split + every limit the API
// reports. Pure read; the rest of BillingTab still owns mutations.

import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { useAccountState } from '@/hooks/billing/use-account-state';
import { cn } from '@/lib/utils';
import { dollarsToCredits, formatCredits } from '@kortix/shared';

type LimitRow = {
  id: string;
  label: string;
  active: number;
  limit: number;
};

interface AccountOverviewTabProps {
  /** Scope the wallet/limits/spend display to a specific account.
   *  Required on /accounts/[id]; omit on global surfaces. */
  accountId?: string;
}

export function AccountOverviewTab({ accountId }: AccountOverviewTabProps = {}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const accountState = useAccountState({ accountId });

  if (accountState.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 w-full rounded-md" />
        <Skeleton className="h-24 w-full rounded-md" />
        <Skeleton className="h-32 w-full rounded-md" />
      </div>
    );
  }

  const state = accountState.data;
  if (!state) {
    return (
      <p className="text-muted-foreground text-sm">
        {tI18nHardcoded.raw('autoFeaturesBillingAccountOverviewJsxTextCouldnTLoadAccountacf6a97f')}
      </p>
    );
  }

  // Per-seat accounts don't use the legacy `tier` field (it stays 'free'), so
  // show the seat plan from billing_model + seats instead of the tier label —
  // otherwise a paying per-seat account renders as "Free".
  const seatCount = state.seats?.count ?? 1;
  const tierName =
    state.billing_model === 'per_seat'
      ? `Team · ${seatCount} seat${seatCount === 1 ? '' : 's'}`
      : state.tier?.display_name || state.tier?.name || 'No plan';
  const subStatus = state.subscription?.status || null;
  const wallet = state.credits?.total ?? 0;
  const tierKey = (state.subscription?.tier_key || state.tier?.name || '').toLowerCase();
  const isFreeTier = state.billing_model !== 'per_seat' && tierKey === 'free';
  const walletValue = isFreeTier
    ? `${formatCredits(dollarsToCredits(wallet))} credits`
    : formatUsd(wallet);
  const usage = state.usage_this_period;
  const limits = buildLimitRows(state.limits);

  return (
    <div className="space-y-8">
      {/* Plan + wallet two-up: current plan on the left, wallet balance on
          the right. */}
      <section className="space-y-4">
        <Label>Plan</Label>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="bg-popover flex min-w-0 flex-col gap-3 rounded-md border p-4">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-foreground text-sm font-medium">{tierName}</p>
              <Badge variant="secondary" size="sm">
                Current
              </Badge>
            </div>
            <p
              className={cn(
                'text-xs capitalize',
                subStatus === 'active' ? 'text-kortix-green' : 'text-muted-foreground',
              )}
            >
              {subStatus === 'active' ? 'Active' : (subStatus ?? 'No subscription')}
            </p>
          </div>
          <div className="bg-popover flex min-w-0 flex-col gap-3 rounded-md border p-4">
            <p className="text-muted-foreground text-base">Wallet balance</p>
            <p className="text-foreground truncate text-xl font-medium tabular-nums">
              {walletValue}
            </p>
          </div>
        </div>
      </section>

      {/* Spend this period */}
      {usage ? (
        <section className="space-y-4">
          <Label>Spend this period</Label>
          <div className="bg-popover divide-border divide-y rounded-md border">
            <SpendRow label="Compute" hint="Sandbox runtime" value={formatUsd(usage.compute_usd)} />
            <SpendRow label="LLM" hint="Inference" value={formatUsd(usage.llm_usd)} />
            <SpendRow label="Total" value={formatUsd(usage.total_usd)} strong />
          </div>
        </section>
      ) : null}

      {/* Limits */}
      {limits.length > 0 ? (
        <section className="space-y-4">
          <Label>Limits</Label>
          <div className="bg-popover space-y-6 rounded-md border px-5 py-6">
            {limits.map((row) => {
              const pct =
                row.limit > 0 ? Math.min(100, Math.round((row.active / row.limit) * 100)) : 0;
              const atCap = row.limit > 0 && row.active >= row.limit;
              return (
                <div key={row.id} className="space-y-2.5">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-foreground">{row.label}</span>
                    <span className={cn('font-medium tabular-nums', atCap && 'text-kortix-red')}>
                      {row.active} / {row.limit}
                    </span>
                  </div>
                  <Progress value={pct} className="h-1.5" />
                </div>
              );
            })}
          </div>
        </section>
      ) : null}
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

function SpendRow({
  label,
  hint,
  value,
  strong,
}: {
  label: string;
  hint?: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <p className={cn('text-sm', strong ? 'text-foreground font-medium' : 'text-foreground')}>
          {label}
        </p>
        {hint ? <p className="text-muted-foreground mt-0.5 text-xs">{hint}</p> : null}
      </div>
      <span className={cn('text-sm tabular-nums', strong ? 'font-semibold' : 'font-medium')}>
        {value}
      </span>
    </div>
  );
}

function formatUsd(amount: number | null | undefined): string {
  const n = typeof amount === 'number' && Number.isFinite(amount) ? amount : 0;
  return `$${n.toFixed(2)}`;
}
