import { siteConfig } from '@/lib/home';

/**
 * Helper function to get plan name - uses tier_key to match cloudPricingItems tier name
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

  // Try to match tier_key to cloudPricingItems to get the frontend tier name
  const tierKey = subscriptionData?.tier_key || subscriptionData?.tier?.name || subscriptionData?.plan_name;
  
  const currentTier = siteConfig.cloudPricingItems.find(
    (p) => p.tierKey === tierKey
  );

  // Return the frontend tier name (Plus, Pro, Ultra, etc.) or fallback to backend display name
  return currentTier?.name || subscriptionData?.display_plan_name || subscriptionData?.tier?.display_name || 'Basic';
}

/**
 * Helper function to get plan icon - maps frontend tier names to icon paths
 * 
 * @param planName - The plan name (e.g., 'Basic', 'Plus', 'Pro', 'Ultra')
 * @param isLocal - Whether running in local mode
 * @returns The path to the plan icon SVG, or null if no icon exists (e.g., Basic tier)
 */
export function getPlanIcon(planName: string, isLocal: boolean = false): string | null {
  if (isLocal) return '/plan-icons/ultra.svg';

  const plan = planName?.toLowerCase();

  // Basic/Free tier - no icon
  if (plan?.includes('free') || plan?.includes('basic')) {
    return '/plan-icons/basic.svg';
  }

  // Ultra tier
  if (plan?.includes('ultra')) {
    return '/plan-icons/ultra.svg';
  }

  // Pro tier (Pro, Business, Enterprise, Scale, Max)
  if (plan?.includes('pro') || plan?.includes('business') || plan?.includes('enterprise') || plan?.includes('scale') || plan?.includes('max')) {
    return '/plan-icons/pro.svg';
  }

  // Plus tier
  if (plan?.includes('plus')) {
    return '/plan-icons/plus.svg';
  }

  // Default to null for any unrecognized plans
  return null;
}

