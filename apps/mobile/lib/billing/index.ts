/**
 * Billing Module
 * 
 * Centralized billing functionality
 * - API client & types
 * - React Query hooks
 * - Checkout flows
 * - Pricing data
 * - Validation utilities
 */

// Re-export everything from submodules
export * from './api';
export * from './hooks';
export * from './checkout';
export * from './pricing';
export * from './validation';

// Named exports for convenience
export { billingApi } from './api';
export { billingKeys } from './hooks';
export {
  startTrialCheckout,
  startPlanCheckout,
  startCreditPurchase,
  openBillingPortal,
  openExternalUrl,
} from './checkout';
export { PRICING_TIERS, CREDIT_PACKAGES } from './pricing';
export { useBillingCheck } from './validation';

