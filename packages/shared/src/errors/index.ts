/**
 * @agentpress/shared/errors
 * 
 * Shared error classes and utilities for handling tier restriction errors,
 * billing errors, and other API errors across frontend and mobile.
 */

// ============================================================================
// Error Classes
// ============================================================================

export class AgentRunLimitError extends Error {
  status: number;
  detail: { 
    message: string;
    running_thread_ids: string[];
    running_count: number;
    limit: number;
  };

  constructor(
    status: number,
    detail: { 
      message: string;
      running_thread_ids: string[];
      running_count: number;
      limit: number;
      [key: string]: any;
    },
    message?: string,
  ) {
    super(message || detail.message || `Worker Run Limit Exceeded: ${status}`);
    this.name = 'AgentRunLimitError';
    this.status = status;
    this.detail = detail;
    Object.setPrototypeOf(this, AgentRunLimitError.prototype);
  }
}

export class AgentCountLimitError extends Error {
  status: number;
  detail: { 
    message: string;
    current_count: number;
    limit: number;
    tier_name: string;
    error_code: string;
  };

  constructor(
    status: number,
    detail: { 
      message: string;
      current_count: number;
      limit: number;
      tier_name: string;
      error_code: string;
      [key: string]: any;
    },
    message?: string,
  ) {
    super(message || detail.message || `Worker Count Limit Exceeded: ${status}`);
    this.name = 'AgentCountLimitError';
    this.status = status;
    this.detail = detail;
    Object.setPrototypeOf(this, AgentCountLimitError.prototype);
  }
}

export class ProjectLimitError extends Error {
  status: number;
  detail: { 
    message: string;
    current_count: number;
    limit: number;
    tier_name: string;
    error_code: string;
  };

  constructor(
    status: number,
    detail: { 
      message: string;
      current_count: number;
      limit: number;
      tier_name: string;
      error_code: string;
      [key: string]: any;
    },
    message?: string,
  ) {
    super(message || detail.message || `Project Limit Exceeded: ${status}`);
    this.name = 'ProjectLimitError';
    this.status = status;
    this.detail = detail;
    Object.setPrototypeOf(this, ProjectLimitError.prototype);
  }
}

export class BillingError extends Error {
  status: number;
  detail: { message: string; [key: string]: any };

  constructor(
    status: number,
    detail: { message: string; [key: string]: any },
    message?: string,
  ) {
    super(message || detail.message || `Billing Error: ${status}`);
    this.name = 'BillingError';
    this.status = status;
    this.detail = detail;
    Object.setPrototypeOf(this, BillingError.prototype);
  }
}

export class TriggerLimitError extends Error {
  status: number;
  detail: { 
    message: string;
    current_count: number;
    limit: number;
    tier_name: string;
    trigger_type: string;
    error_code: string;
  };

  constructor(
    status: number,
    detail: { 
      message: string;
      current_count: number;
      limit: number;
      tier_name: string;
      trigger_type: string;
      error_code: string;
      [key: string]: any;
    },
    message?: string,
  ) {
    super(message || detail.message || `Trigger Limit Exceeded: ${status}`);
    this.name = 'TriggerLimitError';
    this.status = status;
    this.detail = detail;
    Object.setPrototypeOf(this, TriggerLimitError.prototype);
  }
}

export class ModelAccessDeniedError extends Error {
  status: number;
  detail: { 
    message: string;
    tier_name?: string;
    error_code?: string;
  };

  constructor(
    status: number,
    detail: { 
      message: string;
      tier_name?: string;
      error_code?: string;
      [key: string]: any;
    },
    message?: string,
  ) {
    super(message || detail.message || `Model Access Denied: ${status}`);
    this.name = 'ModelAccessDeniedError';
    this.status = status;
    this.detail = detail;
    Object.setPrototypeOf(this, ModelAccessDeniedError.prototype);
  }
}

export class CustomWorkerLimitError extends Error {
  status: number;
  detail: { 
    message: string;
    current_count: number;
    limit: number;
    tier_name: string;
    error_code: string;
  };

  constructor(
    status: number,
    detail: { 
      message: string;
      current_count: number;
      limit: number;
      tier_name: string;
      error_code: string;
      [key: string]: any;
    },
    message?: string,
  ) {
    super(message || detail.message || `Custom Worker Limit Exceeded: ${status}`);
    this.name = 'CustomWorkerLimitError';
    this.status = status;
    this.detail = detail;
    Object.setPrototypeOf(this, CustomWorkerLimitError.prototype);
  }
}

export class ThreadLimitError extends Error {
  status: number;
  detail: { 
    message: string;
    current_count: number;
    limit: number;
    tier_name?: string;
    error_code: string;
  };

  constructor(
    status: number,
    detail: { 
      message: string;
      current_count: number;
      limit: number;
      tier_name?: string;
      error_code: string;
      [key: string]: any;
    },
    message?: string,
  ) {
    super(message || detail.message || `Thread Limit Exceeded: ${status}`);
    this.name = 'ThreadLimitError';
    this.status = status;
    this.detail = detail;
    Object.setPrototypeOf(this, ThreadLimitError.prototype);
  }
}

export class NoAccessTokenAvailableError extends Error {
  constructor(message?: string, options?: { cause?: Error }) {
    super(message || 'No access token available', options);
  }
  name = 'NoAccessTokenAvailableError';
}

export class RequestTooLargeError extends Error {
  status: number;
  detail: {
    message: string;
    suggestion: string;
  };

  constructor(
    status: number = 431,
    detail?: { message?: string; suggestion?: string },
    message?: string,
  ) {
    const defaultMessage = 'Request headers are too large';
    const defaultSuggestion = 'Try uploading files one at a time, or reduce the number of files in a single request.';
    
    super(message || detail?.message || defaultMessage);
    this.name = 'RequestTooLargeError';
    this.status = status;
    this.detail = {
      message: detail?.message || defaultMessage,
      suggestion: detail?.suggestion || defaultSuggestion,
    };
    Object.setPrototypeOf(this, RequestTooLargeError.prototype);
  }
}

// ============================================================================
// Error Parsing Utilities
// ============================================================================

/**
 * Parse a raw API error into a typed tier restriction error.
 * Returns the original error if it's not a tier restriction error.
 */
export function parseTierRestrictionError(error: any): Error {
  const status = error.response?.status || error.status;
  const errorData = error.response?.data || error.data || error.detail || {};
  const errorCode = errorData?.detail?.error_code || errorData?.error_code || error.code;

  if (status !== 402 || !errorCode) {
    return error;
  }

  const detail = errorData?.detail || errorData;

  switch (errorCode) {
    case 'AGENT_RUN_LIMIT_EXCEEDED':
      return new AgentRunLimitError(status, detail);
    
    case 'PROJECT_LIMIT_EXCEEDED':
      return new ProjectLimitError(status, detail);
    
    case 'AGENT_LIMIT_EXCEEDED':
      return new AgentCountLimitError(status, detail);
    
    case 'TRIGGER_LIMIT_EXCEEDED':
      return new TriggerLimitError(status, detail);
    
    case 'MODEL_ACCESS_DENIED':
      return new ModelAccessDeniedError(status, detail);
    
    case 'CUSTOM_WORKER_LIMIT_EXCEEDED':
      return new CustomWorkerLimitError(status, detail);
    
    case 'THREAD_LIMIT_EXCEEDED':
      return new ThreadLimitError(status, detail);
    
    case 'INSUFFICIENT_CREDITS':
      return new BillingError(status, detail);
    
    default:
      // For 402 errors without a specific code, treat as billing error
      if (status === 402) {
        return new BillingError(status, detail);
      }
      return error;
  }
}

/**
 * Check if an error is a billing/limit error that should prompt upgrade
 */
export function isTierRestrictionError(error: any): boolean {
  return (
    error instanceof BillingError ||
    error instanceof AgentRunLimitError ||
    error instanceof ProjectLimitError ||
    error instanceof ThreadLimitError ||
    error instanceof AgentCountLimitError ||
    error instanceof TriggerLimitError ||
    error instanceof ModelAccessDeniedError ||
    error instanceof CustomWorkerLimitError
  );
}

// ============================================================================
// Error State Types for UI
// ============================================================================

export type TierErrorType = 
  | 'THREAD_LIMIT_EXCEEDED'
  | 'AGENT_RUN_LIMIT_EXCEEDED'
  | 'PROJECT_LIMIT_EXCEEDED'
  | 'AGENT_LIMIT_EXCEEDED'
  | 'TRIGGER_LIMIT_EXCEEDED'
  | 'MODEL_ACCESS_DENIED'
  | 'CUSTOM_WORKER_LIMIT_EXCEEDED'
  | 'INSUFFICIENT_CREDITS'
  | 'BILLING_ERROR';

export interface TierLimitErrorState {
  type: TierErrorType;
  message: string;
  currentCount?: number;
  limit?: number;
  tierName?: string;
  runningThreadIds?: string[];
  runningCount?: number;
}

/**
 * Extract a standardized error state from any tier restriction error.
 * This is useful for UI components that need to display error information.
 */
export function extractTierLimitErrorState(error: any): TierLimitErrorState | null {
  if (error instanceof ThreadLimitError) {
    return {
      type: 'THREAD_LIMIT_EXCEEDED',
      message: error.detail.message,
      currentCount: error.detail.current_count,
      limit: error.detail.limit,
      tierName: error.detail.tier_name,
    };
  }

  if (error instanceof AgentRunLimitError) {
    return {
      type: 'AGENT_RUN_LIMIT_EXCEEDED',
      message: error.detail.message,
      runningCount: error.detail.running_count,
      limit: error.detail.limit,
      runningThreadIds: error.detail.running_thread_ids,
    };
  }

  if (error instanceof ProjectLimitError) {
    return {
      type: 'PROJECT_LIMIT_EXCEEDED',
      message: error.detail.message,
      currentCount: error.detail.current_count,
      limit: error.detail.limit,
      tierName: error.detail.tier_name,
    };
  }

  if (error instanceof AgentCountLimitError) {
    return {
      type: 'AGENT_LIMIT_EXCEEDED',
      message: error.detail.message,
      currentCount: error.detail.current_count,
      limit: error.detail.limit,
      tierName: error.detail.tier_name,
    };
  }

  if (error instanceof TriggerLimitError) {
    return {
      type: 'TRIGGER_LIMIT_EXCEEDED',
      message: error.detail.message,
      currentCount: error.detail.current_count,
      limit: error.detail.limit,
      tierName: error.detail.tier_name,
    };
  }

  if (error instanceof ModelAccessDeniedError) {
    return {
      type: 'MODEL_ACCESS_DENIED',
      message: error.detail.message,
      tierName: error.detail.tier_name,
    };
  }

  if (error instanceof CustomWorkerLimitError) {
    return {
      type: 'CUSTOM_WORKER_LIMIT_EXCEEDED',
      message: error.detail.message,
      currentCount: error.detail.current_count,
      limit: error.detail.limit,
      tierName: error.detail.tier_name,
    };
  }

  if (error instanceof BillingError) {
    const message = error.detail?.message?.toLowerCase() || '';
    const isCreditsExhausted = 
      message.includes('credit') ||
      message.includes('balance') ||
      message.includes('insufficient');

    return {
      type: isCreditsExhausted ? 'INSUFFICIENT_CREDITS' : 'BILLING_ERROR',
      message: error.detail.message,
    };
  }

  // Try to parse raw error object (for errors that weren't parsed yet)
  if (error?.status === 402 || error?.code) {
    const errorCode = error?.code || error?.detail?.error_code || error?.error_code;
    const detail = error?.detail || error;

    if (errorCode === 'THREAD_LIMIT_EXCEEDED') {
      return {
        type: 'THREAD_LIMIT_EXCEEDED',
        message: detail.message || 'Thread limit exceeded',
        currentCount: detail.current_count,
        limit: detail.limit,
        tierName: detail.tier_name,
      };
    }

    if (errorCode === 'AGENT_RUN_LIMIT_EXCEEDED') {
      return {
        type: 'AGENT_RUN_LIMIT_EXCEEDED',
        message: detail.message || 'Concurrent run limit exceeded',
        runningCount: detail.running_count,
        limit: detail.limit,
        runningThreadIds: detail.running_thread_ids,
      };
    }
  }

  return null;
}

/**
 * Get a user-friendly title for a tier limit error
 */
export function getTierLimitErrorTitle(errorState: TierLimitErrorState): string {
  switch (errorState.type) {
    case 'THREAD_LIMIT_EXCEEDED':
      return 'Thread Limit Reached';
    case 'AGENT_RUN_LIMIT_EXCEEDED':
      return 'Concurrent Runs Limit';
    case 'PROJECT_LIMIT_EXCEEDED':
      return 'Project Limit Reached';
    case 'AGENT_LIMIT_EXCEEDED':
      return 'Worker Limit Reached';
    case 'TRIGGER_LIMIT_EXCEEDED':
      return 'Trigger Limit Reached';
    case 'MODEL_ACCESS_DENIED':
      return 'Model Access Denied';
    case 'CUSTOM_WORKER_LIMIT_EXCEEDED':
      return 'Custom Worker Limit';
    case 'INSUFFICIENT_CREDITS':
      return 'Credits Exhausted';
    case 'BILLING_ERROR':
      return 'Billing Issue';
    default:
      return 'Limit Reached';
  }
}

/**
 * Get an action label for a tier limit error (e.g., "Upgrade" or "Manage Subscription")
 */
export function getTierLimitErrorAction(errorState: TierLimitErrorState): string {
  switch (errorState.type) {
    case 'AGENT_RUN_LIMIT_EXCEEDED':
      return 'View Running';
    case 'INSUFFICIENT_CREDITS':
    case 'BILLING_ERROR':
      return 'Add Credits';
    default:
      return 'Upgrade';
  }
}
