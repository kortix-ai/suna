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
}

export const PRICING_TIERS: PricingTier[] = [
  {
    id: 'free',
    name: 'Free',
    displayName: 'Free',
    price: '$0',
    priceMonthly: 0,
    priceYearly: 0,
    credits: 2,
    features: [
      '2 credits/m',
      '1 custom agent',
      '1 private project',
      '1 automation trigger',
      'Community support',
    ],
    isPopular: false,
    buttonText: 'Get Started',
  },
  {
    id: 'tier_2_20',
    name: 'Starter',
    displayName: 'Starter',
    price: '$29',
    priceMonthly: 29,
    priceYearly: 24.65, // 15% off = $24.65/month billed yearly
    credits: 29,
    features: [
      '2,900 credits/m',
      '5 custom agents',
      '10 private projects',
      '5 automation triggers',
      'Email support',
      'Basic integrations',
    ],
    isPopular: true,
    buttonText: 'Start Building',
  },
  {
    id: 'tier_6_50',
    name: 'Professional',
    displayName: 'Professional',
    price: '$79',
    priceMonthly: 79,
    priceYearly: 67.15, // 15% off = $67.15/month billed yearly
    credits: 79,
    features: [
      '7,900 credits/m',
      'Unlimited agents',
      '50 private projects',
      '25 automation triggers',
      'Priority email support',
      'Advanced integrations',
      'Custom AI models',
      'API access',
    ],
    buttonText: 'Scale Up',
  },
  {
    id: 'tier_12_100',
    name: 'Business',
    displayName: 'Business',
    price: '$199',
    priceMonthly: 199,
    priceYearly: 169.15, // 15% off = $169.15/month billed yearly
    credits: 199,
    features: [
      '19,900 credits/m',
      'Unlimited agents',
      '200 private projects',
      '100 automation triggers',
      'Phone & chat support',
      'Advanced integrations',
      'Premium AI models',
      'Team collaboration',
      'Usage analytics',
      'Custom workflows',
    ],
    buttonText: 'Go Enterprise',
  },
  {
    id: 'tier_25_200',
    name: 'Enterprise',
    displayName: 'Enterprise',
    price: '$499',
    priceMonthly: 499,
    priceYearly: 424.15, // 15% off = $424.15/month billed yearly
    credits: 499,
    features: [
      '49,900 credits/m',
      'Unlimited everything',
      'Dedicated success manager',
      '24/7 phone support',
      'Custom integrations',
      'Advanced security',
      'SLA guarantee',
      'On-premise deployment',
      'Custom AI training',
      'White-label options',
    ],
    buttonText: 'Contact Sales',
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

