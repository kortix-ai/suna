/**
 * Billing Hooks Index
 * Central export point for all billing-related hooks
 */

// Subscription & Payment
export {
  billingKeys,
  subscriptionKeys,
  useSubscription,
  useSubscriptionWithStreaming,
  useSubscriptionCommitment,
  useCreatePortalSession,
  useCancelSubscription,
  useReactivateSubscription,
  useCreditBalance,
  useBillingStatus,
  useUsageHistory,
  useCreateCheckoutSession,
  usePurchaseCredits,
  useDeductTokenUsage,
  useTriggerTestRenewal,
  useScheduleDowngrade,
  useScheduledChanges,
  useCancelScheduledChange,
  isPlan,
} from './use-subscription';

// Billing Error Handling
export { useBillingModal } from './use-billing-modal';

// Credit & Thread Usage
export { useCreditUsage } from './use-credit-usage';
export { useThreadUsage } from './use-thread-usage';

// Billing Status
export { useBillingStatusQuery } from './use-billing-status';

// Thread Billing
export { useThreadBilling } from './use-thread-billing';

// Trial Management
export { useTrialStatus, useStartTrial } from './use-trial-status';
export { useCancelTrial } from './use-cancel-trial';

// Transactions
export {
  useTransactions,
  useTransactionsSummary,
  type CreditTransaction,
  type TransactionsResponse,
  type TransactionsSummary,
} from './use-transactions';

// Tier Configurations
export {
  useTierConfigurations,
  getTierByKey,
  type TierConfiguration,
  type TierConfigurationsResponse,
} from './use-tier-configurations';

// Admin Billing
export {
  useUserBillingSummary,
  useAdminUserTransactions,
  useAdjustCredits,
  useProcessRefund,
} from './use-admin-billing';

