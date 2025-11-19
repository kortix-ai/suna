/**
 * Billing Module
 * 
 * Centralized billing functionality
 * - API client & types
 * - React Query hooks
 * - Checkout flows
 * - Pricing data
 * 
 * Note: useBillingCheck is NOT exported here to avoid circular dependency
 * with BillingContext. Import it from '@/hooks' or '@/lib/billing/validation' directly.
 */

// Re-export everything from submodules (except validation to avoid circular dependency)
export * from './api';
export * from './hooks';
export * from './pricing';
export * from './checkout';
export * from './usage-api';
export * from './provider';
export * from './revenuecat';
export * from './unified-checkout';

// Named exports for convenience
export { billingApi } from './api';
export { usageApi } from './usage-api';
export {
  startPlanCheckout,
  startCreditPurchase,
  openBillingPortal,
  openExternalUrl,
} from './checkout';
export { PRICING_TIERS } from './pricing';
export {
  getBillingProvider,
  shouldUseRevenueCat,
  shouldUseStripe,
  isRevenueCatConfigured,
} from './provider';
export {
  initializeRevenueCat,
  setRevenueCatAttributes,
  getOfferings,
  purchasePackage,
  restorePurchases,
  getCustomerInfo,
  checkSubscriptionStatus,
  presentPaywall,
} from './revenuecat';
export {
  startUnifiedPlanCheckout,
  startUnifiedCreditPurchase,
} from './unified-checkout';

