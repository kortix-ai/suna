'use client';

import type { PricingPlan } from '@/features/billing/pricing-plans';
import { cn } from '@kortix/ui';
import { CheckCircleIcon } from '@phosphor-icons/react';

interface PricingPlanCardProps {
  plan: PricingPlan;
  action: React.ReactNode;
  /** Replaces the price line. The credits card puts its amount picker here. */
  priceSlot?: React.ReactNode;
  badgeOverride?: string;
  compact?: boolean;
}

export function PricingPlanCard({
  plan,
  action,
  priceSlot,
  badgeOverride,
  compact = false,
}: PricingPlanCardProps) {
  return (
    <div
      className={cn(
        'flex h-full w-full flex-col gap-5 rounded-lg border p-6',
        compact && 'gap-4 p-5',
        plan.highlight && 'bg-accent border-ring/80 ring-ring/30 relative border-[0.5px] ring-2',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-lg font-medium tracking-tight">{plan.name}</div>
          <div className="text-muted-foreground text-md mt-1 text-balance">{plan.note}</div>
        </div>
        {badgeOverride ? (
          <span className="text-muted-foreground shrink-0 text-xs">{badgeOverride}</span>
        ) : null}
      </div>

      {priceSlot ?? (
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="text-2xl" style={{ fontKerning: 'none' }}>
            {plan.price}
          </span>
          {plan.unit && <span className="text-muted-foreground text-sm">{plan.unit}</span>}
        </div>
      )}

      <ul className="flex flex-col space-y-3 text-left text-sm">
        {plan.features.map((feature) => (
          <li key={feature} className="flex items-start justify-start gap-2 first:font-medium">
            <CheckCircleIcon weight="fill" className="text-foreground mt-0.5 size-4 shrink-0" />
            <span>{feature}</span>
          </li>
        ))}
      </ul>

      <div className="mt-auto w-full">{action}</div>
    </div>
  );
}
