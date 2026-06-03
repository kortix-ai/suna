/**
 * Billing & API Error Classes
 * 
 * Simplified from the legacy 8-class hierarchy. The backend (kortix-api)
 * only returns plain HTTP 402 with { message: "..." } for billing errors.
 * All the old error codes (AGENT_RUN_LIMIT_EXCEEDED, THREAD_LIMIT_EXCEEDED, etc.)
 * are no longer emitted by any backend endpoint.
 */

// ============================================================================
// Error Classes
// ============================================================================

/**
 * Generic billing error for HTTP 402 responses.
 * This is the only billing error class the backend actually triggers.
 */
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

/**
 * HTTP 431 - Request Header Fields Too Large.
 * Typically when uploading many files at once.
 */
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
// Error Parsing
// ============================================================================

/**
 * Parse a raw API error into a BillingError if it's a 402.
 * Returns the original error otherwise.
 */
export function parseBillingError(error: any): Error {
  const status = error.response?.status || error.status;
  if (status !== 402) return error;

  const errorData = error.response?.data || error.data || error.detail || {};
  const detail = errorData?.detail || errorData;
  return new BillingError(status, {
    message: detail?.message || error.message || 'Billing error',
    ...detail,
  });
}

/**
 * Check if an error is a billing error that should prompt upgrade.
 */
export function isBillingError(error: any): boolean {
  return error instanceof BillingError;
}

// ============================================================================
// UI Formatting
// ============================================================================

interface BillingErrorUI {
  alertTitle: string;
  alertSubtitle: string;
}

/**
 * Format a billing error for display in the pricing modal.
 */
export function formatBillingErrorForUI(error: any): BillingErrorUI | null {
  if (!(error instanceof BillingError)) return null;

  const message = error.detail?.message?.toLowerCase() || '';
  const isCreditsExhausted =
    message.includes('credit') ||
    message.includes('balance') ||
    message.includes('insufficient');

  if (isCreditsExhausted) {
    return {
      alertTitle: 'You ran out of credits',
      alertSubtitle: 'Upgrade your plan to get more credits and continue using the AI assistant.',
    };
  }

  return {
    alertTitle: 'Billing check failed',
    alertSubtitle: error.detail?.message || 'Please upgrade to continue.',
  };
}
