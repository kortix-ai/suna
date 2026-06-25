'use client';

import { useTranslations } from 'next-intl';
// Account overview block — rendered at the top of the Billing tab.
// One-glance read of plan + this-period spend split + every limit the API
// reports. Pure read; the rest of BillingTab still owns mutations.

import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { useAccountState } from '@/hooks/billing/use-account-state';
import { cn } from '@/lib/utils';
import { dollarsToCredits, formatCredits } from '@kortix/shared';
import { Activity, Bot, Cpu, Layers, Play, Plug, Sparkles, Wallet } from 'lucide-react';

type LimitRow = {
  id: string;
  label: string;
  icon: React.ReactNode;
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
      <div className="space-y-4 px-1 pb-2">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  const state = accountState.data;
  if (!state) {
    return (
      <p className="text-muted-foreground px-1 text-sm">
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
    <div className="space-y-4">
      {/* Plan + wallet + status — compact three-up */}
      <section className="bg-card rounded-2xl border p-5">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Plan">
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="font-medium">
                {tierName}
              </Badge>
              {subStatus && subStatus !== 'active' && (
                <Badge variant="outline" className="text-xs">
                  {subStatus}
                </Badge>
              )}
            </div>
          </Field>
          <Field
            label={tI18nHardcoded.raw(
              'autoFeaturesBillingAccountOverviewJsxAttrLabelWalletBalancecdd0c37d',
            )}
          >
            <ValueLine
              icon={<Wallet className="text-muted-foreground size-4" />}
              value={walletValue}
            />
          </Field>
          <Field label="Status">
            <ValueLine
              icon={<Activity className="text-muted-foreground size-4" />}
              value={subStatus === 'active' ? 'Active' : (subStatus ?? 'Inactive')}
            />
          </Field>
        </div>
      </section>

      {/* Spend this period */}
      {usage && (
        <section className="bg-card rounded-2xl border p-5">
          <div className="mb-4 flex items-baseline justify-between">
            <h4 className="text-sm font-semibold">
              {tI18nHardcoded.raw(
                'autoFeaturesBillingAccountOverviewJsxTextSpendThisPeriodc3ec187b',
              )}
            </h4>
            <span className="text-muted-foreground text-xs tabular-nums">
              {formatUsd(usage.total_usd)} total
            </span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <StatCard
              icon={<Cpu className="size-4" />}
              label="Compute"
              value={formatUsd(usage.compute_usd)}
              sublabel={tI18nHardcoded.raw(
                'autoFeaturesBillingAccountOverviewJsxAttrSublabelSandboxRuntimef66ba97a',
              )}
            />
            <StatCard
              icon={<Sparkles className="size-4" />}
              label="LLM"
              value={formatUsd(usage.llm_usd)}
              sublabel="Inference"
            />
          </div>
        </section>
      )}

      {/* Limits */}
      {limits.length > 0 && (
        <section className="bg-card rounded-2xl border p-5">
          <h4 className="mb-4 text-sm font-semibold">Limits</h4>
          <div className="space-y-3">
            {limits.map((row) => {
              const pct =
                row.limit > 0 ? Math.min(100, Math.round((row.active / row.limit) * 100)) : 0;
              const atCap = row.limit > 0 && row.active >= row.limit;
              return (
                <div key={row.id} className="space-y-1.5">
                  <div className="flex items-center justify-between text-sm">
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground">{row.icon}</span>
                      <span>{row.label}</span>
                    </div>
                    <span className={cn('font-medium tabular-nums', atCap && 'text-destructive')}>
                      {row.active} / {row.limit}
                    </span>
                  </div>
                  <Progress value={pct} className="h-1.5" />
                </div>
              );
            })}
          </div>
        </section>
      )}
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
      icon: <Layers className="size-4" />,
      active: limits.concurrent_sessions.active,
      limit: limits.concurrent_sessions.limit,
    });
  }
  if (limits.concurrent_runs) {
    rows.push({
      id: 'runs',
      label: 'Concurrent agent runs',
      icon: <Play className="size-4" />,
      active: limits.concurrent_runs.running_count,
      limit: limits.concurrent_runs.limit,
    });
  }
  if (limits.ai_worker_count) {
    rows.push({
      id: 'workers',
      label: 'AI workers',
      icon: <Bot className="size-4" />,
      active: limits.ai_worker_count.current_count,
      limit: limits.ai_worker_count.limit,
    });
  }
  if (limits.custom_mcp_count) {
    rows.push({
      id: 'mcps',
      label: 'Custom MCP connectors',
      icon: <Plug className="size-4" />,
      active: limits.custom_mcp_count.current_count,
      limit: limits.custom_mcp_count.limit,
    });
  }
  return rows;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-muted-foreground text-xs">{label}</div>
      {children}
    </div>
  );
}

function ValueLine({ icon, value }: { icon: React.ReactNode; value: string }) {
  return (
    <div className="flex items-center gap-2">
      {icon}
      <span className="text-sm font-medium tabular-nums">{value}</span>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  sublabel,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sublabel?: string;
}) {
  return (
    <div className="bg-background rounded-2xl border p-3">
      <div className="text-muted-foreground flex items-center gap-2 text-xs">
        {icon}
        <span>{label}</span>
      </div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
      {sublabel && <div className="text-muted-foreground mt-0.5 text-xs">{sublabel}</div>}
    </div>
  );
}

function formatUsd(amount: number | null | undefined): string {
  const n = typeof amount === 'number' && Number.isFinite(amount) ? amount : 0;
  return `$${n.toFixed(2)}`;
}
