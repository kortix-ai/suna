export type BillingProvider = 'revenuecat';

/**
 * Always use RevenueCat on mobile app
 */
export function shouldUseRevenueCat(): boolean {
  return true;
}

// Legacy aliases for backwards compatibility
export const isRevenueCatConfigured = shouldUseRevenueCat;
export const getBillingProvider = (): BillingProvider => 'revenuecat';
export const shouldUseStripe = () => false;
