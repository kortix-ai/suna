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

/** Constructor fields for {@link ApiError} — everything beyond `message`. */
export interface ApiErrorFields {
  status?: number;
  code?: string;
  /** Parsed error body (when the response carried JSON). */
  details?: any;
  /** Alias of `details` kept for legacy `.data` sniffers. */
  data?: any;
  /** The body's `detail` field (FastAPI-style), when present. */
  detail?: any;
  response?: Response;
  /** Full request URL — set on timeouts so it's clear what timed out. */
  url?: string;
  /** Request path relative to the backend base — set on timeouts. */
  endpoint?: string;
  /** The timeout budget (ms) that elapsed — set on timeouts. */
  timeout?: number;
  /** Override `name` (e.g. 'AbortError') while keeping the class. */
  name?: string;
  stack?: string;
}

/**
 * The REST error `backendApi` produces for any failed request. A real class —
 * server-side wrappers and non-React hosts can `err instanceof ApiError` and
 * branch on `.status`/`.code` instead of duck-typing `name === 'ApiError'`
 * (which still works: `name` is preserved for legacy sniffers).
 *
 * `message` is defined as an ENUMERABLE own property on purpose: the previous
 * ad-hoc `Object.assign(Object.create(Error.prototype), …)` objects had it
 * enumerable, so spreads and JSON logging of these errors included it.
 */
export class ApiError extends Error {
  status?: number;
  code?: string;
  details?: any;
  data?: any;
  detail?: any;
  response?: Response;
  url?: string;
  endpoint?: string;
  timeout?: number;

  constructor(message: string, fields: ApiErrorFields = {}) {
    super(message);
    this.name = 'ApiError';
    const { name, stack, ...rest } = fields;
    Object.assign(this, rest);
    if (name) this.name = name;
    if (stack) this.stack = stack;
    // `message` is redefined as an enumerable own property on purpose (see the
    // class doc), but the RAW argument is stored — so a non-string `message`
    // (e.g. a backend JSON body like `{ "message": { ... } }` that
    // `makeRequest` failed to coerce) would land here as an object/number and
    // later crash any consumer doing `err.message.includes(...)` with
    // `TypeError: t.message.includes is not a function`. Coerce to a string so
    // `ApiError.message` is ALWAYS a string, matching every consumer's
    // assumption and the `Error` contract.
    const messageStr =
      typeof message === 'string' ? message : message == null ? '' : String(message);
    Object.defineProperty(this, 'message', {
      value: messageStr,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * "No token available" — `getToken` returned null, so the request was never
 * sent (see `api-client.ts`). `code` is always `'NO_SESSION'`.
 */
export class AuthError extends ApiError {
  constructor(message = 'Not authenticated') {
    super(message, { code: 'NO_SESSION' });
    this.name = 'AuthError';
  }
}

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

export interface BillingErrorUI {
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
