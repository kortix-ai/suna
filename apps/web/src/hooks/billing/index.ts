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
  useCreatePerSeatCheckout,
  useCreatePortalSession,
  useCancelSubscription,
  useReactivateSubscription,
  usePurchaseCredits,
  useDeductTokenUsage,
  useScheduleDowngrade,
  useCancelScheduledChange,
  useSyncSubscription,
  
  // Usage history (transactions ledger lives in ./use-transactions below)
  useUsageHistory,

  // Selectors for extracting data
  accountStateSelectors,
} from './use-account-state';

// =============================================================================
// SPECIALIZED HOOKS - Use the unified data internally
// =============================================================================

// Billing modal state
export { useBillingModal } from './use-billing-modal';

// Credits ledger (rich variant with typeFilter, account-scoped via context)
export { useTransactions, useTransactionsSummary } from './use-transactions';

// Download restriction for free tier
export { useDownloadRestriction } from './use-download-restriction';

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
