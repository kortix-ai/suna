'use client';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { Check } from 'lucide-react';
import type { PricingPlan } from '@/features/billing/pricing-plans';

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
        'flex h-full flex-col gap-5 rounded-xl border p-6',
        compact && 'gap-4 p-5',
        plan.highlight &&
          'ring-border bg-border/60 dark:bg-card relative shadow-xl ring-1 shadow-black/6.5 backdrop-blur',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-lg font-medium tracking-tight">{plan.name}</div>
          <div className="text-muted-foreground mt-1 text-sm text-balance">{plan.note}</div>
        </div>
        {badge && (
          <Badge variant="update" className="rounded-full">
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
