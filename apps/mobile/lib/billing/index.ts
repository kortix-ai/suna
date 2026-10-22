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
  useSubscriptionCommitment,
  invalidateCreditsAfterPurchase,
  billingKeys,
  type SubscriptionInfo,
  type CreditBalance,
  type BillingStatus,
} from './hooks';

// =============================================================================
// CHECKOUT & PAYMENTS
// =============================================================================
// Web checkout functions removed - only native checkout supported
// openBillingPortal and openExternalUrl still available for redirecting Stripe subscribers to web app
export {
  openBillingPortal,
  openExternalUrl,
} from './checkout';

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
  presentPaywall,
  presentCustomerInfo,
  isRevenueCatInitialized,
} from './revenuecat';
export type { RevenueCatProduct } from './revenuecat';
