'use client';

// Billing v2 — seat management card.
// Rendered when account_state.billing_model === 'per_seat'. Shows seat count,
// monthly cost, and the running spend breakdown (compute vs LLM) sourced from
// credit_ledger aggregation. The wallet itself is a single number — only the
// SPEND attribution is split.

import type { AccountState } from '@/lib/api/billing';
import { Cpu, Sparkles, Users } from 'lucide-react';

export interface SeatManagementCardProps {
  accountState: AccountState;
}

export function SeatManagementCard({ accountState }: SeatManagementCardProps) {
  const seats = accountState.seats;
  if (!seats || accountState.billing_model !== 'per_seat') return null;

  const monthlyTotal = seats.price_per_seat_usd * seats.count;
  const usage = accountState.usage_this_period;

  return (
    <div className="rounded-2xl border bg-card p-6 space-y-5">
      <header className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="rounded-md bg-muted p-2 text-muted-foreground">
            <Users className="size-5" />
          </div>
          <div>
            <h3 className="text-base font-semibold">Team seats</h3>
            <p className="text-sm text-muted-foreground">
              ${seats.price_per_seat_usd}/teammate · includes compute + LLM usage
            </p>
          </div>
        </div>
        <div className="text-right">
          <div className="text-2xl font-semibold tabular-nums">${monthlyTotal}</div>
          <div className="text-xs text-muted-foreground">
            {seats.count} {seats.count === 1 ? 'seat' : 'seats'} · /mo
          </div>
        </div>
      </header>

      {usage ? (
        <div className="space-y-3">
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            This period
          </h4>
          <div className="grid grid-cols-2 gap-3">
            <UsageStat
              icon={<Cpu className="size-4" />}
              label="Compute"
              valueUsd={usage.compute_usd}
            />
            <UsageStat
              icon={<Sparkles className="size-4" />}
              label="LLM"
              valueUsd={usage.llm_usd}
            />
          </div>
          <div className="flex items-baseline justify-between border-t pt-3 text-sm">
            <span className="text-muted-foreground">Total spend this period</span>
            <span className="tabular-nums font-medium">${usage.total_usd.toFixed(2)}</span>
          </div>
        </div>
      ) : null}

      <p className="text-xs text-muted-foreground border-t pt-4">
        Adding a teammate adds ${seats.price_per_seat_usd}/mo and grants ${seats.price_per_seat_usd}
        {' '}of wallet credits. Spend it on compute, LLM, or both — prorated automatically.
      </p>
    </div>
  );
}

function UsageStat({
  icon,
  label,
  valueUsd,
}: {
  icon: React.ReactNode;
  label: string;
  valueUsd: number;
}) {
  return (
    <div className="rounded-2xl border bg-background p-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {icon}
        <span>{label}</span>
      </div>
      <div className="mt-1 text-xl font-semibold tabular-nums">${valueUsd.toFixed(2)}</div>
    </div>
  );
}
