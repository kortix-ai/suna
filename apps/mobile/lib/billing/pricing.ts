/**
 * Pricing Configuration
 * 
 * Defines subscription tiers with backend tier keys
 * Matches backend and frontend pricing configuration
 */

import { useProductionStripeIds, ENV_MODE } from '@/lib/utils/env-config';
import { Sparkles, Zap, Rocket, Crown } from 'lucide-react-native';

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
  icon?: any; // React component type for icon
  revenueCatId?: string; // RevenueCat product identifier (e.g., 'kortix_plus_monthly')
}

/**
 * Pricing Tier Configuration
 * 
 * This array contains FEATURE DESCRIPTIONS and METADATA for each tier.
 * When RevenueCat is enabled (iOS/Android), actual PRICING and AVAILABILITY 
 * are loaded from App Store/Play Store via getOfferings().
 * 
 * The PricingSection component merges:
 * - RevenueCat data (price, product ID, availability)
 * - Hardcoded data (features, icons, descriptions)
 * 
 * Features MUST match frontend/src/lib/home.tsx exactly.
 */
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
      '200 credits/month',
      '1 custom Worker',
      '1 private project',
      '1 custom trigger',
    ],
    isPopular: false,
    buttonText: 'Select',
    hidden: false,
    icon: Sparkles,
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
      '2,000 credits/month',
      '5 custom workers',
      'Private projects',
      '100+ integrations',
      'Premium AI Models',
    ],
    isPopular: true,
    buttonText: 'Get started',
    hidden: false,
    icon: Zap,
    revenueCatId: 'kortix_plus',
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
      '5,000 credits/month',
      '20 custom workers',
      'Private projects',
      '100+ integrations',
      'Premium AI Models',
    ],
    isPopular: false,
    buttonText: 'Get started',
    hidden: false,
    icon: Rocket,
    revenueCatId: 'kortix_pro',
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
      '10,000 credits/month',
      '20 custom workers',
      'Private projects',
      '100+ integrations',
      'Premium AI Models',
    ],
    isPopular: false,
    buttonText: 'Get started',
    hidden: true, // Hidden by default, matching frontend
    icon: Rocket,
    revenueCatId: 'kortix_business',
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
      '20,000 credits/month',
      '100 custom workers',
      'Private projects',
      '100+ integrations',
      'Premium AI Models',
      'Priority Support',
    ],
    isPopular: false,
    buttonText: 'Get started',
    hidden: false,
    icon: Crown,
    revenueCatId: 'kortix_ultra',
  },
];

export type BillingPeriod = 'monthly' | 'yearly' | 'yearly_commitment';

/**
 * Get the display price based on billing period
 */
export function getDisplayPrice(
  tier: PricingTier,
  period: BillingPeriod
): string {
  if ((period === 'yearly' || period === 'yearly_commitment') && tier.priceYearly) {
    // Yearly: -10%, Yearly Commitment: -15%
    const yearlyPrice = period === 'yearly' 
      ? tier.priceMonthly * 0.9 
      : tier.priceYearly;
    return `$${yearlyPrice.toFixed(0)}`;
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

