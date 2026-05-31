// Subscription tier structure - tier keys only, no price IDs
export interface SubscriptionTierData {
  tierKey: string;  // Backend tier key like 'free', 'pro', etc.
  name: string;     // Display name like 'Free', 'Pro'
}

// Subscription tiers structure - ONLY tier keys, price IDs come from backend
export interface SubscriptionTiers {
  FREE_TIER: SubscriptionTierData;
  PRO: SubscriptionTierData;
  // Legacy tiers kept for backward compat (existing users)
  TIER_2_20: SubscriptionTierData;
  TIER_6_50: SubscriptionTierData;
  TIER_12_100: SubscriptionTierData;
  TIER_25_200: SubscriptionTierData;
  TIER_50_400: SubscriptionTierData;
  TIER_125_800: SubscriptionTierData;
  TIER_200_1000: SubscriptionTierData;
}

// Configuration object
interface Config {
  SUBSCRIPTION_TIERS: SubscriptionTiers;
}

// Tier keys - single source, no environment-specific price IDs
const TIERS: SubscriptionTiers = {
  FREE_TIER: {
    tierKey: 'free',
    name: 'Free/$0',
  },
  PRO: {
    tierKey: 'pro',
    name: 'Pro/$20',
  },
  // Legacy tiers
  TIER_2_20: {
    tierKey: 'tier_2_20',
    name: 'Plus/$20',
  },
  TIER_6_50: {
    tierKey: 'tier_6_50',
    name: 'Pro/$50',
  },
  TIER_12_100: {
    tierKey: 'tier_12_100',
    name: 'Business/$100',
  },
  TIER_25_200: {
    tierKey: 'tier_25_200',
    name: 'Ultra/$200',
  },
  TIER_50_400: {
    tierKey: 'tier_50_400',
    name: 'Enterprise/$400',
  },
  TIER_125_800: {
    tierKey: 'tier_125_800',
    name: 'Scale/$800',
  },
  TIER_200_1000: {
    tierKey: 'tier_200_1000',
    name: 'Max/$1000',
  },
} as const;

export const config: Config = {
  SUBSCRIPTION_TIERS: TIERS,
};

/**
 * Whether billing (Stripe, credit tracking, paywall, plan picker) is enabled on
 * the frontend. Single switch — NEXT_PUBLIC_BILLING_ENABLED — which should
 * mirror the backend's KORTIX_BILLING_INTERNAL_ENABLED. Everything else (auth,
 * sandbox provisioning, projects, accounts) runs the same code path whether
 * billing is on or off.
 */
export const isBillingEnabled = (): boolean => {
  return getEnv().BILLING_ENABLED;
};

import { getEnv } from '@/lib/env-config';

