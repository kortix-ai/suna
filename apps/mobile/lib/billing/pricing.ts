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
  description?: string;
  features: string[];
  disabledFeatures?: string[];
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
 * The PlanPage component merges:
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
    description: 'Perfect for getting started',
    features: [
      '100 daily credits - Refreshes every 24 hours (applies to all tiers)',
      '1 concurrent run',
      '10 Total Chats',
      'Basic Mode - Core Kortix experience with basic autonomy',
    ],
    disabledFeatures: [
      // 'No custom AI Workers',
      // 'No scheduled triggers',
      // 'No app-based triggers',
      // 'No integrations',
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
    credits: 40, // $40/month = 4,000 credits/month (40 * 100)
    description: 'Best for individuals and small teams',
    features: [
      'CREDITS_BONUS:2000:4000',
      'Unlimited Chats',
      '3 concurrent runs - Run multiple Chats simultaneously',
      // '5 custom AI Workers - Create Kortix Agents with custom Knowledge, Tools & Integrations',
      // '5 scheduled triggers - Run at 9am daily, every Monday, first of month...',
      // '25 app triggers - Auto-respond to new emails, Slack messages, form submissions...',
      // '100+ Integrations - Google Drive, Slack, Notion, Gmail, Calendar, GitHub & more',
      'Kortix Advanced mode - Strongest autonomy & decision-making capabilities',
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
    credits: 100, // $100/month = 10,000 credits/month (100 * 100)
    description: 'Ideal for growing businesses',
    features: [
      'CREDITS_BONUS:5000:10000',
      'Unlimited Chats',
      '5 concurrent runs - Run multiple Chats simultaneously',
      // '20 custom AI Workers - Create Kortix Agents with custom Knowledge, Tools & Integrations',
      // '10 scheduled triggers - Run at 9am daily, every Monday, first of month...',
      // '50 app triggers - Auto-respond to new emails, Slack messages, form submissions...',
      // '100+ Integrations - Google Drive, Slack, Notion, Gmail, Calendar, GitHub & more',
      'Kortix Advanced mode - Strongest autonomy & decision-making capabilities',
    ],
    isPopular: false,
    buttonText: 'Get started',
    hidden: false,
    icon: Rocket,
    revenueCatId: 'kortix_pro',
  },
  {
    id: 'tier_25_200',
    name: 'Ultra',
    displayName: 'Ultra',
    price: '$200',
    priceMonthly: 200,
    // No yearly option available for Ultra
    credits: 400, // $400/month = 40,000 credits/month (400 * 100)
    description: 'For power users',
    features: [
      'CREDITS_BONUS:20000:40000',
      'Unlimited Chats',
      '20 concurrent runs - Run multiple Chats simultaneously',
      // '100 custom AI Workers - Create Kortix Agents with custom Knowledge, Tools & Integrations',
      // '50 scheduled triggers - Run at 9am daily, every Monday, first of month...',
      // '200 app triggers - Auto-respond to new emails, Slack messages, form submissions...',
      // '100+ Integrations - Google Drive, Slack, Notion, Gmail, Calendar, GitHub & more',
      'Kortix Advanced mode - Strongest autonomy & decision-making capabilities',
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

