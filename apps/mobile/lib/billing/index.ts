// =============================================================================
// CORE EXPORTS - Unified Account State
// =============================================================================
export { accountStateSelectors, type AccountState } from './api';
export {
  useAccountState,
  accountStateKeys,
  invalidateAccountState,
  useSubscription,
  useCreditBalance,
  useBillingStatus,
  useCancelScheduledChange,
  useSubscriptionCommitment,
  useScheduledChanges,
  invalidateCreditsAfterPurchase,
  billingKeys,
  type SubscriptionInfo,
  type CreditBalance,
  type BillingStatus,
} from './hooks';

// =============================================================================
// PRICING HOOK
// =============================================================================
export { useRevenueCatPricing } from '../../hooks/billing/useRevenueCatPricing';

// =============================================================================
// CHECKOUT & PAYMENTS
// =============================================================================
// Web checkout functions removed - only native checkout supported
// openBillingPortal and openExternalUrl still available for redirecting Stripe subscribers to web app
export {
  openBillingPortal,
  openExternalUrl,
} from './checkout';
export {
  startUnifiedPlanCheckout,
  startUnifiedCreditPurchase,
} from './unified-checkout';

// =============================================================================
// PRICING & TIERS
// =============================================================================
export { PRICING_TIERS, getDisplayPrice, getYearlySavings } from './pricing';
export type { PricingTier, BillingPeriod } from './pricing';

// =============================================================================
// PROVIDER UTILITIES
// =============================================================================
export {
  getBillingProvider,
  shouldUseRevenueCat,
  shouldUseStripe,
  isRevenueCatConfigured,
} from './provider';
export { canShowExternalPurchase } from './store-policy';
export { getUpgradeSheetIncludedItems } from './upgrade-sheet-included';

// =============================================================================
// REVENUECAT
// =============================================================================
export {
  initializeRevenueCat,
  setRevenueCatAttributes,
  getOfferings,
  getOfferingById,
  purchasePackage,
  getCustomerInfo,
  checkSubscriptionStatus,
  presentPaywall,
  presentCustomerInfo,
  isRevenueCatInitialized,
} from './revenuecat';
export type { RevenueCatProduct } from './revenuecat';

// =============================================================================
// PLAN UTILITIES
// =============================================================================

export { logAvailableProducts, findPackageForTier } from './revenuecat-utils';
export { debugRevenueCat, isRevenueCatWorking } from './debug-revenuecat';
export {
  getRevenueCatPricing,
  getRevenueCatDisplayPrice,
  getRevenueCatPackageForCheckout,
  getRevenueCatYearlySavings,
  type RevenueCatPricingData
} from './revenuecat-pricing';

