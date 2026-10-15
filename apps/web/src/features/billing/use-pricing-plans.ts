'use client';

import {
  PRICING_FEATURE_COUNTS,
  PRICING_PLANS,
  type PricingPlan,
  type PricingPlanId,
} from '@/features/billing/pricing-plans';
import { useTranslations } from '@/i18n/use-translations';
import { useMemo } from 'react';

/** The three plan cards in the visitor's language. Structure and order come
 *  from `PRICING_PLANS`; every string comes from `billing.pricing.plans.*`. */
export function usePricingPlans(): PricingPlan[] {
  const t = useTranslations('billing.pricing.plans');
  return useMemo(
    () =>
      PRICING_PLANS.map((plan) => {
        const id: PricingPlanId = plan.id;
        return {
          ...plan,
          name: t(`${id}.name`),
          note: t(`${id}.note`),
          ...(id === 'enterprise' ? { price: t('enterprise.price') } : {}),
          ...(plan.unit ? { unit: t(`${id}.unit`) } : {}),
          features: Array.from({ length: PRICING_FEATURE_COUNTS[id] }, (_, index) =>
            t(`${id}.f${index + 1}`),
          ),
        };
      }),
    [t],
  );
}

/** The cards the in-app upgrade modal shows: Free and Credits, no Enterprise. */
export function useUpgradePlans(): PricingPlan[] {
  const plans = usePricingPlans();
  return useMemo(() => plans.filter((plan) => plan.id !== 'enterprise'), [plans]);
}
