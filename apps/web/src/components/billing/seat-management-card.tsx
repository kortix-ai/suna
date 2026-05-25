'use client';

// Billing v2 — seat management card.
// Only rendered when account_state.billing_model === 'per_seat'. Shows current
// seat count, the headline price, and the running tally of included compute +
// YOLO budgets so the member can see what their $20/seat is paying for.

import type { AccountState } from '@/lib/api/billing';
import { Users } from 'lucide-react';

export interface SeatManagementCardProps {
  accountState: AccountState;
}

export function SeatManagementCard({ accountState }: SeatManagementCardProps) {
  const seats = accountState.seats;
  if (!seats || accountState.billing_model !== 'per_seat') return null;

  const monthlyTotal = seats.price_per_seat_usd * seats.count;
  const computeIncluded = seats.included_compute_per_seat_usd * seats.count;
  const yoloIncluded = seats.included_yolo_per_seat_usd * seats.count;
  const computeRemainingPct = computeIncluded
    ? Math.max(0, Math.min(100, Math.round((seats.included_compute_remaining_usd / computeIncluded) * 100)))
    : 0;
  const yoloRemainingPct = yoloIncluded
    ? Math.max(0, Math.min(100, Math.round((seats.included_yolo_remaining_usd / yoloIncluded) * 100)))
    : 0;

  return (
    <div className="rounded-lg border bg-card p-6 space-y-5">
      <header className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="rounded-md bg-muted p-2 text-muted-foreground">
            <Users className="size-5" />
          </div>
          <div>
            <h3 className="text-base font-semibold">Team seats</h3>
            <p className="text-sm text-muted-foreground">
              ${seats.price_per_seat_usd}/seat — includes Kortix YOLO + compute budget
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

      <div className="grid grid-cols-2 gap-4">
        <BudgetBar
          label="Compute"
          totalUsd={computeIncluded}
          remainingUsd={seats.included_compute_remaining_usd}
          percent={computeRemainingPct}
        />
        <BudgetBar
          label="Kortix YOLO"
          totalUsd={yoloIncluded}
          remainingUsd={seats.included_yolo_remaining_usd}
          percent={yoloRemainingPct}
        />
      </div>

      <p className="text-xs text-muted-foreground">
        Adding a teammate adds ${seats.price_per_seat_usd}/mo and grants
        ${seats.included_compute_per_seat_usd + seats.included_yolo_per_seat_usd} of included usage
        for that seat. Stripe handles proration automatically.
      </p>
    </div>
  );
}

function BudgetBar({
  label,
  totalUsd,
  remainingUsd,
  percent,
}: {
  label: string;
  totalUsd: number;
  remainingUsd: number;
  percent: number;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums">
          ${remainingUsd.toFixed(2)} <span className="text-muted-foreground">/ ${totalUsd.toFixed(0)}</span>
        </span>
      </div>
      <div className="mt-1.5 h-2 rounded-full bg-muted overflow-hidden">
        <div
          className="h-full bg-primary transition-[width] duration-300"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
