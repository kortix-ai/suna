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
  
  // Query keys for manual invalidation if needed
  accountStateKeys,
  invalidateAccountState,
  
  // Mutation hooks
  useCreatePerSeatCheckout,
  useCreatePortalSession,

  // Selectors for extracting data
  accountStateSelectors,
} from './use-account-state';

// =============================================================================
// SPECIALIZED HOOKS - Use the unified data internally
// =============================================================================

// Download restriction for free tier
export { useDownloadRestriction } from './use-download-restriction';
