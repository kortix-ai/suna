// =============================================================================
// CORE EXPORTS - Unified Account State
// =============================================================================
export { billingApi, accountStateSelectors, type AccountState } from './api';
export { 
  useAccountState,
  useAccountStateWithStreaming,
  accountStateKeys,
  invalidateAccountState,
  useSubscription,
  useCreditBalance,
  useBillingStatus,
  useCancelScheduledChange,
  useSubscriptionCommitment,
  useScheduledChanges,
  invalidateCreditsAfterPurchase,
  useCreateCheckoutSession,
  useCreatePortalSession,
  useCancelSubscription,
  useReactivateSubscription,
  usePurchaseCredits,
  useDeductTokenUsage,
  useScheduleDowngrade,
  useSyncSubscription,
  useUsageHistory,
  useTransactions,
  useTrialStatus,
  useStartTrial,
  useCancelTrial,
  billingKeys,
  type SubscriptionInfo,
  type CreditBalance,
  type BillingStatus,
} from './hooks';

// =============================================================================
// USAGE & THREAD HOOKS
// =============================================================================
export { useThreadUsage } from './use-thread-usage';
export type { ThreadUsageResponse, ThreadUsageRecord } from './use-thread-usage';
export { useCreditUsage } from './use-credit-usage';
export type { UsageRecord, UsageResponse } from './use-credit-usage';
export { usageApi } from './usage-api';

// =============================================================================
// CHECKOUT & PAYMENTS
// =============================================================================
export {
  startPlanCheckout,
  startCreditPurchase,
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
export { PRICING_TIERS, getDisplayPrice } from './pricing';
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

// =============================================================================
// REVENUECAT
// =============================================================================
export {
  initializeRevenueCat,
  setRevenueCatAttributes,
  getOfferings,
  getOfferingById,
  purchasePackage,
  restorePurchases,
  getCustomerInfo,
  checkSubscriptionStatus,
  presentPaywall,
} from './revenuecat';
export type { RevenueCatProduct } from './revenuecat';

// =============================================================================
// PLAN UTILITIES
// =============================================================================
export { getPlanName, getPlanIcon } from './plan-utils';

