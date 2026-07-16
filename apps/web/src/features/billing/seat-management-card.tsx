'use client';

import { useTranslations } from 'next-intl';
// Billing v2 — seat management card.
// Rendered when account_state.billing_model === 'per_seat'. Shows seat count,
// monthly cost, and the running spend breakdown (compute vs LLM) sourced from
// credit_ledger aggregation. The wallet itself is a single number — only the
// SPEND attribution is split.

import { Label } from '@/components/ui/label';
import type { AccountState } from '@/lib/api/billing';

export interface SeatManagementCardProps {
  accountState: AccountState;
}

export function SeatManagementCard({ accountState }: SeatManagementCardProps) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const seats = accountState.seats;
  if (!seats || accountState.billing_model !== 'per_seat') return null;

  const monthlyTotal = seats.price_per_seat_usd * seats.count;
  const usage = accountState.usage_this_period;

  return (
    <section className="space-y-4">
      <Label>Team seats</Label>
      <div className="bg-popover rounded-md border">
        <div className="flex items-start justify-between gap-4 px-4 py-4">
          <div className="min-w-0">
            <p className="text-foreground text-sm font-medium">
              ${seats.price_per_seat_usd}
              {tI18nHardcoded.raw(
                'autoFeaturesBillingSeatManagementCardJsxTextTeammateIncludesCompute626f1aeb',
              )}
            </p>
            <p className="text-muted-foreground mt-0.5 text-xs">
              {seats.count} {seats.count === 1 ? 'seat' : 'seats'}{' '}
              {tI18nHardcoded.raw('autoFeaturesBillingSeatManagementCardJsxTextModba31324')}
            </p>
          </div>
          <div className="shrink-0 text-right">
            <div className="text-xl font-semibold tabular-nums">${monthlyTotal}</div>
            <div className="text-muted-foreground text-xs">per month</div>
          </div>
        </div>

        {usage ? (
          <div className="divide-border border-border divide-y border-t">
            <SpendRow label="Compute" value={usage.compute_usd} />
            <SpendRow label="LLM" value={usage.llm_usd} />
            <SpendRow
              label={tI18nHardcoded.raw(
                'autoFeaturesBillingSeatManagementCardJsxTextTotalSpendThis908ba767',
              )}
              value={usage.total_usd}
              strong
            />
          </div>
        ) : null}

        <p className="text-muted-foreground border-border border-t px-4 py-3 text-xs">
          {tI18nHardcoded.raw('autoFeaturesBillingSeatManagementCardJsxTextAddingATeammateb0681f04')}
          {seats.price_per_seat_usd}
          {tI18nHardcoded.raw('autoFeaturesBillingSeatManagementCardJsxTextMoAndGrants5da9d984')}
          {seats.price_per_seat_usd}{' '}
          {tI18nHardcoded.raw('autoFeaturesBillingSeatManagementCardJsxTextOfWalletCreditsc4eec42f')}
        </p>
      </div>
    </section>
  );
}

function SpendRow({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-2.5 text-sm">
      <span className={strong ? 'text-foreground font-medium' : 'text-muted-foreground'}>
        {label}
      </span>
      <span className={strong ? 'font-semibold tabular-nums' : 'font-medium tabular-nums'}>
        ${value.toFixed(2)}
      </span>
    </div>
  );
}
