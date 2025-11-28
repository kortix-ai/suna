/**
 * Billing Hooks Index
 * 
 * UNIFIED APPROACH: All billing state comes from useAccountState
 * This provides a single source of truth and optimizes API calls.
 */

// =============================================================================
// PRIMARY HOOK - Use this for all billing data
// =============================================================================

export {
  // Main hook
  useAccountState,
  useAccountStateWithStreaming,
  
  // Query keys for manual invalidation if needed
  accountStateKeys,
  invalidateAccountState,
  
  // Mutation hooks
  useCreateCheckoutSession,
  useCreatePortalSession,
  useCancelSubscription,
  useReactivateSubscription,
  usePurchaseCredits,
  useDeductTokenUsage,
  useScheduleDowngrade,
  useCancelScheduledChange,
  useSyncSubscription,
  
  // Usage/transactions (separate queries)
  useUsageHistory,
  useTransactions,
  
  // Trial
  useTrialStatus,
  useStartTrial,
  useCancelTrial,
  
  // Selectors for extracting data
  accountStateSelectors,
} from './use-account-state';

// =============================================================================
// SPECIALIZED HOOKS - Use the unified data internally
// =============================================================================

// Thread billing (uses useAccountState internally)
export { useThreadBilling } from './use-thread-billing';

// Billing modal state
export { useBillingModal } from './use-billing-modal';

// Credit & Thread Usage analytics
export { useCreditUsage } from './use-credit-usage';
export { useThreadUsage } from './use-thread-usage';

// =============================================================================
// TIER CONFIGURATIONS - Static data, separate endpoint
// =============================================================================

export {
  useTierConfigurations,
  getTierByKey,
  type TierConfiguration,
  type TierConfigurationsResponse,
} from './use-tier-configurations';

// =============================================================================
// ADMIN HOOKS - For admin dashboard
// =============================================================================

export {
  useUserBillingSummary,
  useAdminUserTransactions,
  useAdjustCredits,
  useProcessRefund,
} from './use-admin-billing';

// =============================================================================
// TYPE EXPORTS
// =============================================================================

export type { AccountState } from '@/lib/api/billing';
