'use client';

import { Badge } from '@/components/ui/badge';
import type { PricingPlan } from '@/features/billing/pricing-plans';
import { cn } from '@/lib/utils';
import { Check } from 'lucide-react';

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
        'flex h-full flex-col gap-5 rounded-md border p-6',
        compact && 'gap-4 p-5',
        plan.highlight && 'bg-card dark:bg-card relative border shadow-xs',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-lg font-medium tracking-tight">{plan.name}</div>
          <div className="text-muted-foreground mt-1 text-sm text-balance">{plan.note}</div>
        </div>
        {badge && (
          <Badge variant="update" className="rounded">
            {badge}
          </Badge>
        )}
      </div>

      <div className="flex min-w-0 items-baseline gap-2">
        <span className="text-4xl" style={{ fontKerning: 'none' }}>
          {priceOverride ?? plan.price}
        </span>
        {plan.unit && <span className="text-muted-foreground text-sm">{plan.unit}</span>}
      </div>

      <div className="mt-auto space-y-5">
        {action}

        <ul className="flex flex-col space-y-3 text-left text-sm">
          {plan.features.map((feature) => (
            <li key={feature} className="flex items-start justify-start gap-2 first:font-medium">
              <Check className="text-foreground mt-0.5 size-4 shrink-0" />
              <span>{feature}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
