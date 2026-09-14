'use client';

import type { AccountState } from '@kortix/sdk';
import { useTranslations } from '@/i18n/use-translations';

/**
 * Team seats — rendered when `account_state.billing_model === 'per_seat'`.
 *
 * **Restyle (2026-08-13).** This card used to carry its own copy of the spend
 * breakdown (Compute / LLM / Total) under the seat row. The balance card at
 * the top of the pane now shows exactly those three numbers for the same
 * period, so a per-seat account read them twice, four rows apart, from the
 * same `usage_this_period` object. The duplicate is gone; what is left is the
 * one thing only this card knows — what the seats cost.
 */

export interface SeatManagementCardProps {
  accountState: AccountState;
}

export function SeatManagementCard({ accountState }: SeatManagementCardProps) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const seats = accountState.seats;
  if (!seats || accountState.billing_model !== 'per_seat') return null;

  const monthlyTotal = seats.price_per_seat_usd * seats.count;

  return (
    <div className="bg-popover flex items-center justify-between gap-4 rounded-md border px-4 py-3">
      <div className="min-w-0">
        <p className="text-foreground text-sm font-medium">
          {tI18nComplete.raw('text42ef2c24bd7a')}
        </p>
        <p className="text-muted-foreground mt-0.5 text-xs tabular-nums">
          {seats.count} {seats.count === 1 ? 'seat' : 'seats'} · ${seats.price_per_seat_usd}{' '}
          {tI18nComplete.raw('text6a65480c06db')}
        </p>
      </div>
      <p className="shrink-0 text-right text-sm font-semibold tabular-nums">
        ${monthlyTotal}
        <span className="text-muted-foreground ml-1 text-xs font-normal">
          {tI18nComplete.raw('textdcc954337afd')}
        </span>
      </p>
    </div>
  );
}
