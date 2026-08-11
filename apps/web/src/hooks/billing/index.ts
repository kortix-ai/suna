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
  // Query keys for manual invalidation if needed
  accountStateKeys,
  // Selectors for extracting data
  accountStateSelectors,
  invalidateAccountState,
  // Main hook
  useAccountState,
  useAccountStateWithStreaming,
  useCancelScheduledChange,
  useCancelSubscription,
  // Mutation hooks
  useCreateCheckoutSession,
  useCreatePerSeatCheckout,
  useCreatePortalSession,
  usePurchaseCredits,
  useReactivateSubscription,
  useScheduleDowngrade,
  useSyncSubscription,

  // Usage history (transactions ledger lives in ./use-transactions below)
  useUsageHistory,
} from './use-account-state';

// =============================================================================
// SPECIALIZED HOOKS - Use the unified data internally
// =============================================================================

// Billing modal state
export { useBillingModal } from './use-billing-modal';

// Credits ledger (rich variant with typeFilter, account-scoped via context)
export { useTransactions, useTransactionsSummary } from './use-transactions';

// Session-first LLM and compute cost explorer
export {
  SESSION_COST_PAGE_SIZE,
  useSessionCostDetail,
  useSessionCostProjects,
  useSessionCosts,
} from './use-session-costs';

// Project -> sessions cost explorer (account-wide summary and rollup)
export { COST_PAGE_SIZE, useCostByProject, useCostSummary } from './use-cost-explorer';

// Download restriction for free tier
export { useDownloadRestriction } from './use-download-restriction';

// =============================================================================
// TIER CONFIGURATIONS - Static data, separate endpoint
// =============================================================================

export {
  getTierByKey,
  useTierConfigurations,
  type TierConfiguration,
  type TierConfigurationsResponse,
} from './use-tier-configurations';

// =============================================================================
// ADMIN HOOKS - For admin dashboard
// =============================================================================

export {
  useAdjustCredits,
  useAdminUserTransactions,
  useProcessRefund,
  useUserBillingSummary,
} from './use-admin-billing';

// =============================================================================
// TYPE EXPORTS
// =============================================================================

export type { AccountState, PlanFamily, ResolvedPlanView } from '@kortix/sdk';

/**
 * The plan the account BEHAVES as. Prefer this over
 * `accountStateSelectors.tierKey` for anything a person reads and for any
 * "is this account on a paid plan?" branch — `tier_key` is the STORED plan and
 * stays `free` for an admin trial and for a paying per-seat team with a stale
 * row, so branching on it makes the UI contradict the server.
 */
export { resolvedPlan } from '@kortix/sdk';
