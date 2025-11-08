import { siteConfig } from '@/lib/home';

/**
 * Helper function to get plan name - uses tier_key to match cloudPricingItems tier name
 * 
 * @param subscriptionData - Subscription data from API
 * @param isLocal - Whether running in local mode
 * @returns The display name of the plan (e.g., 'Basic', 'Plus', 'Pro', 'Ultra')
 */
export function getPlanName(subscriptionData: any, isLocal: boolean = false): string {
  if (isLocal) return 'Enterprise';

  // Handle null/undefined subscription data
  if (!subscriptionData) {
    if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
      console.warn('[getPlanName] No subscription data provided');
    }
    return 'Free';
  }

  // Handle free tier explicitly
  if (subscriptionData?.tier?.name === 'free' || subscriptionData?.tier_key === 'free') {
    return 'Free';
  }

  // Try to match tier_key to cloudPricingItems to get the frontend tier name
  const tierKey = subscriptionData?.tier_key || subscriptionData?.tier?.name || subscriptionData?.plan_name;

  const currentTier = siteConfig.cloudPricingItems.find(
    (p) => p.tierKey === tierKey
  );

  if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
    console.log('[getPlanName]', {
      tierKey,
      foundTier: currentTier?.name,
      subscriptionTier: subscriptionData?.tier?.name,
      availableTiers: siteConfig.cloudPricingItems.map(p => ({ name: p.name, key: p.tierKey }))
    });
  }

  // Return the frontend tier name (Starter, Professional, Business, Enterprise, etc.) or fallback to backend display name
  return currentTier?.name || subscriptionData?.display_plan_name || subscriptionData?.tier?.display_name || 'Free';
}

/**
 * Helper function to get plan icon - maps frontend tier names to icon paths
 * 
 * @param planName - The plan name (e.g., 'Basic', 'Plus', 'Pro', 'Ultra')
 * @param isLocal - Whether running in local mode
 * @returns The path to the plan icon SVG, or null if no icon exists (e.g., Basic tier)
 */
export function getPlanIcon(planName: string, isLocal: boolean = false): string | null {
  if (isLocal) return '/plan-icons/pro.svg';

  const plan = planName?.toLowerCase();

  // Free tier
  if (plan?.includes('free')) {
    return '/plan-icons/basic.svg';
  }

  // Starter tier
  if (plan?.includes('starter')) {
    return '/plan-icons/plus.svg';
  }

  // Professional tier
  if (plan?.includes('professional')) {
    return '/plan-icons/pro.svg';
  }

  // Business tier
  if (plan?.includes('business')) {
    return '/plan-icons/pro.svg';
  }

  // Enterprise tier
  if (plan?.includes('enterprise')) {
    return '/plan-icons/ultra.svg';
  }

  // Default to null for any unrecognized plans
  return null;
}

