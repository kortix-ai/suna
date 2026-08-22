'use client';

import type { PricingPlan } from '@/features/billing/pricing-plans';
import { cn } from '@/lib/utils';
import { CheckCircleIcon } from '@phosphor-icons/react';

interface PricingPlanCardProps {
  plan: PricingPlan;
  action: React.ReactNode;
  priceOverride?: string;
  badgeOverride?: string;
  compact?: boolean;
}

export function PricingPlanCard({
  plan,
  action,
  priceOverride,
  badgeOverride,
  compact = false,
}: PricingPlanCardProps) {
  const badge = badgeOverride ?? plan.badge;

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
      </div>

      <div className="flex min-w-0 items-baseline gap-2">
        <span className="text-4xl" style={{ fontKerning: 'none' }}>
          {priceOverride ?? plan.price}
        </span>
        {plan.unit && <span className="text-muted-foreground text-sm">{plan.unit}</span>}
      </div>

      <ul className="flex flex-col space-y-3 text-left text-sm">
        {plan.features.map((feature) => (
          <li key={feature} className="flex items-start justify-start gap-2 first:font-medium">
            <CheckCircleIcon weight="fill" className="text-foreground mt-0.5 size-4 shrink-0" />
            <span>
              <span>{feature}</span>
              {plan.featureDetails?.[feature] ? (
                <span className="text-muted-foreground mt-0.5 block text-xs leading-relaxed font-normal">
                  {plan.featureDetails[feature]}
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>

      <div className="mt-auto w-full">{action}</div>
    </div>
  );
}
