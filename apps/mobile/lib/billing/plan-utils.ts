/**
 * Plan Utilities
 * 
 * Helper functions for plan name and icon resolution
 * Matches frontend implementation exactly
 */

import { PRICING_TIERS } from './pricing';

/**
 * Helper function to get plan name - uses tier_key to match PRICING_TIERS
 * 
 * @param subscriptionData - Subscription data from API
 * @param isLocal - Whether running in local mode
 * @returns The display name of the plan (e.g., 'Basic', 'Plus', 'Pro', 'Ultra')
 */
export function getPlanName(subscriptionData: any, isLocal: boolean = false): string {
  if (isLocal) return 'Ultra';

  // Handle null/undefined subscription data
  if (!subscriptionData) {
    return 'Basic';
  }

  // Handle free tier explicitly
  if (subscriptionData?.tier?.name === 'free' || subscriptionData?.tier_key === 'free') {
    return 'Basic';
  }

  // Try to match tier_key to PRICING_TIERS to get the frontend tier name
  const tierKey = subscriptionData?.tier_key || subscriptionData?.tier?.name || subscriptionData?.plan_name;
  
  const currentTier = PRICING_TIERS.find(
    (p) => p.id === tierKey
  );

  // Return the frontend tier name (Plus, Pro, Ultra, etc.) or fallback to backend display name
  return currentTier?.name || subscriptionData?.display_plan_name || subscriptionData?.tier?.display_name || 'Basic';
}

/**
 * Helper function to get plan icon path - maps frontend tier names to icon paths
 * 
 * @param planName - The plan name (e.g., 'Basic', 'Plus', 'Pro', 'Ultra')
 * @param isLocal - Whether running in local mode
 * @returns Object with the SVG component and plan name, or null if no icon exists
 */
export function getPlanIcon(planName: string, isLocal: boolean = false): 'basic' | 'plus' | 'pro' | 'ultra' | null {
  if (isLocal) return 'ultra';

  const plan = planName?.toLowerCase();

  // Basic/Free tier
  if (plan?.includes('free') || plan?.includes('basic')) {
    return 'basic';
  }

  // Ultra tier
  if (plan?.includes('ultra')) {
    return 'ultra';
  }

  // Pro tier (Pro, Business, Enterprise, Scale, Max)
  if (plan?.includes('pro') || plan?.includes('business') || plan?.includes('enterprise') || plan?.includes('scale') || plan?.includes('max')) {
    return 'pro';
  }

  // Plus tier
  if (plan?.includes('plus')) {
    return 'plus';
  }

  // Default to null for any unrecognized plans
  return null;
}
