/**
 * Re-export error classes and utilities from @agentpress/shared
 * This ensures consistency between frontend and mobile error handling.
 */
export {
  // Error classes
  AgentRunLimitError,
  AgentCountLimitError,
  ProjectLimitError,
  BillingError,
  TriggerLimitError,
  ModelAccessDeniedError,
  CustomWorkerLimitError,
  ThreadLimitError,
  NoAccessTokenAvailableError,
  RequestTooLargeError,
  // Parsing utilities
  parseTierRestrictionError,
  isTierRestrictionError,
  // Error state types and utilities
  extractTierLimitErrorState,
  getTierLimitErrorTitle,
  getTierLimitErrorAction,
} from '@agentpress/shared/errors';

export type {
  TierErrorType,
  TierLimitErrorState,
} from '@agentpress/shared/errors';
