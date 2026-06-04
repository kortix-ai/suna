export type BillingProvider = 'revenuecat' | 'none';

/**
 * Use RevenueCat only when billing is enabled (cloud mode).
 * Self-hosted / local dev: billing is disabled.
 *
 * NOTE: RevenueCat is temporarily disabled for mobile.
 * To re-enable, uncomment the original logic below and remove the early return.
 */
export function shouldUseRevenueCat(): boolean {
  // ── TEMPORARILY DISABLED ──────────────────────────────────────────────
  // Mobile payments via RevenueCat are disabled for now.
  // Re-enable by removing this return and uncommenting the logic below.
  return false;

  // const useRC = process.env.EXPO_PUBLIC_USE_REVENUECAT;
  // const billingEnabled = process.env.EXPO_PUBLIC_BILLING_ENABLED;
  // // Disabled if either flag is explicitly "false" or not set
  // if (useRC === 'false' || billingEnabled === 'false') return false;
  // return useRC === 'true';
}

// Legacy aliases for backwards compatibility
export const isRevenueCatConfigured = shouldUseRevenueCat;
export const getBillingProvider = (): BillingProvider => 'none';
export const shouldUseStripe = () => false;
