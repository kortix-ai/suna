/**
 * Pricing Configuration
 * 
 * Defines subscription tiers with backend tier keys
 * Matches backend and frontend pricing configuration
 */

import { useProductionStripeIds, ENV_MODE } from '@/lib/utils/env-config';

export interface PricingTier {
  id: string;  // Backend tier key (e.g., 'free', 'tier_2_20')
  name: string;
  displayName: string;
  price: string;
  priceMonthly: number;
  priceYearly?: number;
  credits: number;
  features: string[];
  isPopular?: boolean;
  buttonText: string;
  hidden?: boolean;
}

export const PRICING_TIERS: PricingTier[] = [
  {
    id: 'free',
    name: 'Basic',
    displayName: 'Basic',
    price: '$0',
    priceMonthly: 0,
    priceYearly: 0,
    credits: 2,
    features: [
      '200 credits/m',
      '1 custom Worker',
      '1 private project',
      '1 custom trigger',
    ],
    isPopular: false,
    buttonText: 'Select',
    hidden: false,
  },
  {
    id: 'tier_2_20',
    name: 'Plus',
    displayName: 'Plus',
    price: '$20',
    priceMonthly: 20,
    priceYearly: 17, // 15% off = $17/month billed yearly
    credits: 20,
    features: [
      '2,000 credits/m',
      '5 custom agents',
      'Private projects',
      'Custom abilities',
      '100+ integrations',
      'Premium AI Models',
      'Advanced AI Capabilities',
    ],
    isPopular: true,
    buttonText: 'Get Started',
    hidden: false,
  },
  {
    id: 'tier_6_50',
    name: 'Pro',
    displayName: 'Pro',
    price: '$50',
    priceMonthly: 50,
    priceYearly: 42.5, // 15% off = $42.50/month billed yearly
    credits: 50,
    features: [
      '5,000 credits/m',
      '20 custom agents',
      'Private projects',
      'Custom abilities',
      '100+ integrations',
      'Premium AI Models',
      'Advanced AI Capabilities',
    ],
    isPopular: false,
    buttonText: 'Get Started',
    hidden: false,
  },
  {
    id: 'tier_12_100',
    name: 'Business',
    displayName: 'Business',
    price: '$100',
    priceMonthly: 100,
    priceYearly: 85, // 15% off = $85/month billed yearly
    credits: 100,
    features: [
      '10,000 credits/m',
      '20 custom agents',
      'Private projects',
      'Custom abilities',
      '100+ integrations',
      'Premium AI Models',
      'Advanced AI Capabilities',
    ],
    isPopular: false,
    buttonText: 'Get Started',
    hidden: true, // Hidden by default, matching frontend
  },
  {
    id: 'tier_25_200',
    name: 'Ultra',
    displayName: 'Ultra',
    price: '$200',
    priceMonthly: 200,
    priceYearly: 170, // 15% off = $170/month billed yearly
    credits: 200,
    features: [
      '20,000 credits/m',
      '100 custom agents',
      'Private projects',
      'Custom abilities',
      '100+ integrations',
      'Premium AI Models',
      'Priority Support',
      'Advanced AI Capabilities',
    ],
    isPopular: false,
    buttonText: 'Get Started',
    hidden: false,
  },
];

export type BillingPeriod = 'monthly' | 'yearly_commitment';

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

