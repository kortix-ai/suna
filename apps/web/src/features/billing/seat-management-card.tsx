'use client';

import { useTranslations } from 'next-intl';
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
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const seats = accountState.seats;
  if (!seats || accountState.billing_model !== 'per_seat') return null;

  const monthlyTotal = seats.price_per_seat_usd * seats.count;
  const usage = accountState.usage_this_period;

  return (
    <div className="bg-card space-y-5 rounded-2xl border p-6">
      <header className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="bg-muted text-muted-foreground rounded-md p-2">
            <Users className="size-5" />
          </div>
          <div>
            <h3 className="text-base font-semibold">
              {tI18nHardcoded.raw('autoFeaturesBillingSeatManagementCardJsxTextTeamSeatsac65209c')}
            </h3>
            <p className="text-muted-foreground text-sm">
              ${seats.price_per_seat_usd}
              {tI18nHardcoded.raw(
                'autoFeaturesBillingSeatManagementCardJsxTextTeammateIncludesCompute626f1aeb',
              )}
            </p>
          </div>
        </div>
        <div className="text-right">
          <div className="text-2xl font-semibold tabular-nums">${monthlyTotal}</div>
          <div className="text-muted-foreground text-xs">
            {seats.count} {seats.count === 1 ? 'seat' : 'seats'}{' '}
            {tI18nHardcoded.raw('autoFeaturesBillingSeatManagementCardJsxTextModba31324')}
          </div>
        </div>
      </header>

      {usage ? (
        <div className="space-y-3">
          <h4 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            {tI18nHardcoded.raw('autoFeaturesBillingSeatManagementCardJsxTextThisPeriode510d764')}
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
            <span className="text-muted-foreground">
              {tI18nHardcoded.raw(
                'autoFeaturesBillingSeatManagementCardJsxTextTotalSpendThis908ba767',
              )}
            </span>
            <span className="font-medium tabular-nums">${usage.total_usd.toFixed(2)}</span>
          </div>
        </div>
      ) : null}

      <p className="text-muted-foreground border-t pt-4 text-xs">
        {tI18nHardcoded.raw('autoFeaturesBillingSeatManagementCardJsxTextAddingATeammateb0681f04')}
        {seats.price_per_seat_usd}
        {tI18nHardcoded.raw('autoFeaturesBillingSeatManagementCardJsxTextMoAndGrants5da9d984')}
        {seats.price_per_seat_usd}{' '}
        {tI18nHardcoded.raw('autoFeaturesBillingSeatManagementCardJsxTextOfWalletCreditsc4eec42f')}
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
    <div className="bg-background rounded-2xl border p-3">
      <div className="text-muted-foreground flex items-center gap-2 text-xs">
        {icon}
        <span>{label}</span>
      </div>
      <div className="mt-1 text-xl font-semibold tabular-nums">${valueUsd.toFixed(2)}</div>
    </div>
  );
}
