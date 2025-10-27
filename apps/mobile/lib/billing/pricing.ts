/**
 * Pricing Configuration
 * 
 * Defines subscription tiers with environment-specific Stripe price IDs
 * Matches backend and frontend pricing configuration
 */

import { useProductionStripeIds, ENV_MODE } from '@/lib/utils/env-config';

export interface PricingTier {
  id: string;
  name: string;
  displayName: string;
  price: string;
  priceMonthly: number;
  priceYearly?: number;
  stripePriceId: string;
  stripeYearlyPriceId?: string;
  stripeYearlyCommitmentPriceId?: string;
  credits: number;
  features: string[];
  isPopular?: boolean;
  buttonText: string;
}

export const PRICING_TIERS: PricingTier[] = [
  {
    id: 'tier_2_20',
    name: 'Plus',
    displayName: 'Plus',
    price: '$20',
    priceMonthly: 20,
    priceYearly: 17, // 15% off = $17/month billed yearly
    stripePriceId: useProductionStripeIds
      ? 'price_1RILb4G6l1KZGqIrhomjgDnO'      // Production monthly
      : 'price_1RIGvuG6l1KZGqIrCRu0E4Gi',      // Staging/Local monthly
    stripeYearlyPriceId: useProductionStripeIds
      ? 'price_1ReHB5G6l1KZGqIrD70I1xqM'      // Production yearly
      : 'price_1ReGogG6l1KZGqIrEyBTmtPk',      // Staging/Local yearly
    stripeYearlyCommitmentPriceId: useProductionStripeIds
      ? 'price_1RqtqiG6l1KZGqIrhjVPtE1s'      // Production commitment
      : 'price_1RqYGaG6l1KZGqIrIzcdPzeQ',      // Staging/Local commitment
    credits: 20,
    features: [
      '$20 AI token credits/m',
      '5 custom agents',
      'Private projects',
      '100+ integrations',
      'Premium AI Models',
    ],
    isPopular: true,
    buttonText: 'Get Started',
  },
  {
    id: 'tier_6_50',
    name: 'Pro',
    displayName: 'Pro',
    price: '$50',
    priceMonthly: 50,
    priceYearly: 42.5, // 15% off = $42.50/month billed yearly
    stripePriceId: useProductionStripeIds
      ? 'price_1RILb4G6l1KZGqIr5q0sybWn'      // Production monthly
      : 'price_1RIGvuG6l1KZGqIrvjlz5p5V',      // Staging/Local monthly
    stripeYearlyPriceId: useProductionStripeIds
      ? 'price_1ReHAsG6l1KZGqIrlAog487C'      // Production yearly
      : 'price_1ReGoJG6l1KZGqIr0DJWtoOc',      // Staging/Local yearly
    stripeYearlyCommitmentPriceId: useProductionStripeIds
      ? 'price_1Rqtr8G6l1KZGqIrQ0ql0qHi'      // Production commitment
      : 'price_1RqYH1G6l1KZGqIrWDKh8xIU',      // Staging/Local commitment
    credits: 50,
    features: [
      '$50 AI token credits/m',
      '20 custom agents',
      'Private projects',
      '100+ integrations',
      'Premium AI Models',
    ],
    buttonText: 'Get Started',
  },
  {
    id: 'tier_12_100',
    name: 'Business',
    displayName: 'Business',
    price: '$100',
    priceMonthly: 100,
    priceYearly: 85, // 15% off = $85/month billed yearly
    stripePriceId: useProductionStripeIds
      ? 'price_1RILb4G6l1KZGqIr5Y20ZLHm'      // Production monthly
      : 'price_1RIGvuG6l1KZGqIrT6UfgblC',      // Staging/Local monthly
    stripeYearlyPriceId: useProductionStripeIds
      ? 'price_1ReHAWG6l1KZGqIrBHer2PQc'      // Production yearly
      : 'price_1ReGnZG6l1KZGqIr0ThLEl5S',      // Staging/Local yearly
    credits: 100,
    features: [
      '$100 AI token credits/m',
      'Unlimited custom agents',
      'Private projects',
      '100+ integrations',
      'Premium AI Models',
      'Priority support',
    ],
    buttonText: 'Get Started',
  },
];

export type BillingPeriod = 'monthly' | 'yearly_commitment';

/**
 * Get the appropriate price ID based on billing period
 */
export function getPriceId(
  tier: PricingTier,
  period: BillingPeriod
): string {
  if (period === 'yearly_commitment' && tier.stripeYearlyCommitmentPriceId) {
    return tier.stripeYearlyCommitmentPriceId;
  }
  return tier.stripePriceId;
}

/**
 * Get the display price based on billing period
 */
export function getDisplayPrice(
  tier: PricingTier,
  period: BillingPeriod
): string {
  if (period === 'yearly_commitment' && tier.priceYearly) {
    return `$${tier.priceYearly}`;
  }
  return tier.price;
}

/**
 * Calculate savings for yearly commitment
 */
export function getYearlySavings(tier: PricingTier): number {
  if (!tier.priceYearly) return 0;
  return (tier.priceMonthly - tier.priceYearly) * 12;
}

