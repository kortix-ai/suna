'use client';

import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { kortix } from '@/lib/kortix';
import { relativeTime } from '@/lib/utils';
import { useQuery } from '@tanstack/react-query';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

function signedUsd(amount: number) {
  return amount > 0 ? `+${usd.format(amount)}` : usd.format(amount);
}

/**
 * Billing overview — `billing.accountState({ accountId })` for the plan and
 * credit balances, `billing.transactions({ accountId, limit })` for the
 * recent ledger, and `billing.transactionsSummary({ accountId, days })` for
 * the 30-day totals. `billing.creditBreakdown()` takes no accountId — the
 * backend keys it off the authenticated caller — so that card is labeled
 * accordingly. Display-only: no checkout/portal/cancel flows in this demo.
 */
export function BillingSection({ accountId }: { accountId: string }) {
  const state = useQuery({
    queryKey: ['billing-state', accountId],
    queryFn: () => kortix.billing.accountState({ accountId }),
  });
  const breakdown = useQuery({
    queryKey: ['billing-credit-breakdown'],
    queryFn: () => kortix.billing.creditBreakdown(),
  });
  const transactions = useQuery({
    queryKey: ['billing-transactions', accountId],
    queryFn: () => kortix.billing.transactions({ accountId, limit: 10 }),
  });
  const summary = useQuery({
    queryKey: ['billing-transactions-summary', accountId],
    queryFn: () => kortix.billing.transactionsSummary({ accountId, days: 30 }),
  });

  const s = state.data;
  const creditStats = [
    { label: 'Monthly', value: s?.credits.monthly ?? 0 },
    { label: 'Daily', value: s?.credits.daily ?? 0 },
    { label: 'Extra', value: s?.credits.extra ?? 0 },
  ];
  const b = breakdown.data;
  const breakdownRows = b
    ? [
        { label: 'Expiring', value: b.expiring },
        { label: 'Non-expiring', value: b.non_expiring },
        { label: 'Daily', value: b.daily },
      ].filter((row) => row.value !== 0)
    : [];
  const txns = (transactions.data?.transactions ?? []).slice(0, 10);

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold text-foreground">Billing</h3>

      {/* Plan + credits — billing.accountState */}
      <Card className="gap-0 p-5">
        {state.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-4 w-56" />
          </div>
        ) : state.isError ? (
          <p className="text-sm text-destructive">Couldn&apos;t load billing state.</p>
        ) : s ? (
          <>
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <div className="truncate text-sm font-medium">{s.tier.display_name}</div>
                  <Badge variant="secondary" className="capitalize">
                    {s.subscription.status.replace(/_/g, ' ')}
                  </Badge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  <span className="tabular-nums">{usd.format(s.tier.monthly_credits)}</span> in
                  monthly credits
                  {s.subscription.billing_period
                    ? ` · billed ${s.subscription.billing_period.replace(/_/g, ' ')}`
                    : ''}
                  {s.subscription.cancel_at_period_end ? ' · cancels at period end' : ''}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <div className="text-xs text-muted-foreground">Credits balance</div>
                <div className="text-lg font-semibold tabular-nums">
                  {usd.format(s.credits.total)}
                </div>
              </div>
            </div>
            <Separator className="my-4" />
            <div className="grid grid-cols-3 gap-4">
              {creditStats.map((stat) => (
                <div key={stat.label}>
                  <div className="text-xs text-muted-foreground">{stat.label}</div>
                  <div className="text-sm font-medium tabular-nums">{usd.format(stat.value)}</div>
                </div>
              ))}
            </div>
          </>
        ) : null}
      </Card>

      {/* Balance breakdown — billing.creditBreakdown (caller-scoped, no accountId) */}
      {breakdown.isSuccess && breakdownRows.length > 0 && (
        <Card className="gap-0 p-5">
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm font-medium">Credit breakdown</div>
            <div className="text-xs text-muted-foreground">Your balance, not account-scoped</div>
          </div>
          <div className="mt-3 space-y-2">
            {breakdownRows.map((row) => (
              <div key={row.label} className="flex items-center justify-between gap-3">
                <div className="text-xs text-muted-foreground">{row.label}</div>
                <div className="text-sm tabular-nums">{usd.format(row.value)}</div>
              </div>
            ))}
          </div>
          <Separator className="my-3" />
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs text-muted-foreground">Total</div>
            <div className="text-sm font-medium tabular-nums">{usd.format(b?.total ?? 0)}</div>
          </div>
        </Card>
      )}

      {/* Ledger — billing.transactions + billing.transactionsSummary */}
      <Card className="divide-y divide-border p-0">
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="text-sm font-medium">Recent transactions</div>
          {summary.isSuccess && (
            <div className="text-xs text-muted-foreground tabular-nums">
              {usd.format(summary.data.totalCredits)} in · {usd.format(summary.data.totalDebits)}{' '}
              out · 30 days
            </div>
          )}
        </div>
        {transactions.isLoading && (
          <div className="space-y-2 p-4">
            <Skeleton className="h-5 w-56" />
            <Skeleton className="h-5 w-44" />
          </div>
        )}
        {transactions.isError && (
          <div className="p-6 text-center text-sm text-destructive">
            Couldn&apos;t load transactions.
          </div>
        )}
        {transactions.isSuccess && txns.length === 0 && (
          <div className="p-6 text-center text-sm text-muted-foreground">No transactions yet.</div>
        )}
        {txns.map((t) => (
          <div key={t.id} className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium capitalize">
                {t.type.replace(/_/g, ' ')}
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {t.description ? `${t.description} · ` : ''}
                {relativeTime(t.created_at)}
              </div>
            </div>
            <div className="shrink-0 text-sm font-medium tabular-nums">{signedUsd(t.amount)}</div>
          </div>
        ))}
      </Card>
    </section>
  );
}
