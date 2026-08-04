import { platformConfig } from './config';
import { getSupabaseAccessTokenWithRetry } from './auth';
import { ApiError, AuthError, parseBillingError, RequestTooLargeError } from './api/errors';

const getApiUrl = () => platformConfig().backendUrl || '';

// Ported from web's error-handler. User-facing error handling is routed
// through platformConfig().onError?.() instead of web's handleApiError.
// The error classes live in ./api/errors — re-exported here so both the
// root barrel and the `@kortix/sdk/api-client` subpath expose them.
export {
  ApiError,
  AuthError,
  BillingError,
  RequestTooLargeError,
  parseBillingError,
  isBillingError,
  formatBillingErrorForUI,
  type ApiErrorFields,
  type BillingErrorUI,
} from './api/errors';

export interface ErrorContext {
  operation?: string;
  resource?: string;
  silent?: boolean;
}

export interface ApiClientOptions {
  showErrors?: boolean;
  errorContext?: ErrorContext;
  timeout?: number;
}

export interface ApiResponse<T = any> {
  data?: T;
  error?: ApiError;
  success: boolean;
}

/**
 * Stable error code the platform API returns (HTTP 501) when an OPTIONAL
 * capability isn't wired on the current deployment — e.g. connector
 * auth-discovery, Pipedream. `makeRequest` classifies a 501 carrying this code
 * as an EXPECTED "feature unavailable" state and drops it from Sentry; callers
 * branch on `err.code === FEATURE_NOT_SUPPORTED_CODE`. Must stay in sync with
 * `apps/api/src/executor/router.ts`'s `FEATURE_NOT_SUPPORTED_CODE`.
 */
export const FEATURE_NOT_SUPPORTED_CODE = 'feature_not_supported';

/**
 * Stable error code the platform API returns (HTTP 409) when a user tries to
 * set a model their account can't use — e.g. a managed model on a free tier,
 * or a BYOK model whose provider isn't connected. The API emits this from the
 * model-defaults PUT (`apps/api/src/projects/routes/r4.ts`) and the channel
 * binding model set (`apps/api/src/projects/routes/channel-bindings.ts`) via
 * `isModelServableForAccount`. This is an EXPECTED condition — a UI validation
 * error, not a server bug — so `makeRequest` classifies a 409 carrying this
 * code as SILENT to `onError` (Sentry) but still returns the `ApiError` so the
 * caller (`useModelDefaults`'s `setMutation` `onError`) can branch on `.code`
 * and show a user-facing toast. A genuine 409 (no typed `model_not_servable`
 * code) still reports to Sentry. Must stay in sync with the API-side
 * `code: 'model_not_servable'` strings. Mirrors `FEATURE_NOT_SUPPORTED_CODE`
 * (PR #5240) and the billing-gate 402 / no-compaction-model classification.
 */
export const MODEL_NOT_SERVABLE_CODE = 'model_not_servable';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * HTTP statuses that represent a transient gateway / overload condition rather
 * than a deterministic server-side failure: 502 (Bad Gateway), 503 (Service
 * Unavailable), 504 (Gateway Timeout). These are produced by the load balancer
 * / reverse proxy / the API's request-deadline net under momentary saturation,
 * typically resolve within a few hundred ms, and are safe to retry on
 * idempotent reads. A real 500 is NOT here — it's a deterministic bug and must
 * surface on the first response.
 */
const TRANSIENT_GATEWAY_STATUSES = new Set([502, 503, 504]);
const isTransientGatewayStatus = (status: number): boolean =>
  TRANSIENT_GATEWAY_STATUSES.has(status);

/** Idempotent HTTP methods that are safe to transparently retry. GET/HEAD only
 *  — POST/PUT/PATCH/DELETE mutate state and must not be replayed by the client. */
const isIdempotentMethod = (method?: string): boolean => {
  const m = (method ?? 'GET').toUpperCase();
  return m === 'GET' || m === 'HEAD';
};

const TRANSIENT_READ_RETRIES = 2;

const isAbortError = (error: unknown): boolean =>
  (error as { name?: string } | null)?.name === 'AbortError' ||
  (error as { name?: string } | null)?.name === 'AbortSignal' ||
  (error instanceof Error && error.message.includes('aborted'));

// Platform-admin read-only bypass toggle (web only). In-memory, per-tab — never
// persisted — so it resets on reload and can't linger silently. When on, every
// request from this client carries `x-kortix-admin-bypass: 1`; the API only
// honors it for a real platform admin/super_admin on a `read` action (see
// apps/api/src/projects/lib/access.ts), so this is safe to set unconditionally
// here rather than threading it through every call site.
let adminBypassEnabled = false;

export function setAdminBypass(enabled: boolean): void {
  adminBypassEnabled = enabled;
}

export function isAdminBypassEnabled(): boolean {
  return adminBypassEnabled;
}

async function makeRequest<T = any>(
  url: string,
  options: RequestInit & ApiClientOptions = {}
): Promise<ApiResponse<T>> {
  const {
    showErrors = true,
    errorContext,
    timeout = 30000,
    ...fetchOptions
  } = options;

  const controller = new AbortController();
  let timeoutId: NodeJS.Timeout | null = null;
  let isAborted = false;
  // Tracks whether *our* timer fired the abort, vs. an external abort
  // (client navigation, tab close, dropped connection). Only the former is a
  // real timeout; the latter must not be surfaced as one.
  let didTimeout = false;

  try {
    timeoutId = setTimeout(() => {
      if (!isAborted && !controller.signal.aborted) {
        isAborted = true;
        didTimeout = true;
        controller.abort();
      }
    }, timeout);

    const token = await getSupabaseAccessTokenWithRetry();

    // Don't set Content-Type for FormData - browser will set it automatically with boundary
    const isFormData = fetchOptions.body instanceof FormData;
    const headers: Record<string, string> = {};

    if (!isFormData) {
      headers['Content-Type'] = 'application/json';
    }

    // Merge with any headers from fetchOptions
    Object.assign(headers, fetchOptions.headers as Record<string, string>);

    if (adminBypassEnabled) {
      headers['x-kortix-admin-bypass'] = '1';
    }

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    } else {
      // No session yet — Supabase hasn't hydrated from cookies.
      // Return a silent failure instead of sending a naked request that will 401.
      // Callers gated by `enabled: !!user` should prevent this path, but this
      // is a safety net for any calls that slip through.
      return {
        error: new AuthError(),
        success: false,
      };
    }

    // Note: X-Refresh-Token was removed to reduce header size and prevent HTTP 431 errors.
    // The backend handles token refresh via Supabase directly.

    const retryableRead = isIdempotentMethod(fetchOptions.method);
    const maxAttempts = retryableRead ? TRANSIENT_READ_RETRIES + 1 : 1;
    let response!: Response;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        await sleep(250 * 2 ** (attempt - 1));
      }

      const attemptController = attempt === 0 ? controller : new AbortController();
      if (attempt > 0) {
        timeoutId = setTimeout(() => {
          didTimeout = true;
          attemptController.abort();
        }, timeout);
      }

      try {
        response = await fetch(url, {
          ...fetchOptions,
          headers,
          signal: attemptController.signal,
          credentials: fetchOptions.credentials ?? 'omit',
        });
      } catch (error) {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        if (isAbortError(error) || attempt === maxAttempts - 1) {
          throw error;
        }
        continue;
      }

      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }

      const retryableResponse =
        retryableRead && isTransientGatewayStatus(response.status) && attempt < maxAttempts - 1;
      if (!retryableResponse) {
        break;
      }

      try {
        await response.arrayBuffer();
      } catch {
      }
    }

    if (!response.ok) {
      let errorMessage = `HTTP ${response.status}: ${response.statusText}`;
      let errorData: any = null;

      try {
        errorData = await response.json();
        if (typeof errorData.message === 'string') {
          errorMessage = errorData.message;
        } else if (errorData.error && typeof errorData.error === 'string') {
          errorMessage = errorData.error;
        } else if (typeof errorData.detail === 'string') {
          // FastAPI returns {"detail": "error message"}
          errorMessage = errorData.detail;
        } else if (typeof errorData.detail?.message === 'string') {
          errorMessage = errorData.detail.message;
        }
      } catch {
      }

      let error: ApiError | Error = new ApiError(errorMessage, {
        status: response.status,
        response: response,
        details: errorData || undefined,
        data: errorData,
        detail: errorData?.detail,
        code: errorData?.code || errorData?.error_code || errorData?.detail?.error_code || response.status.toString()
      });

      if (response.status === 402) {
        error = parseBillingError(error);
      }

      // Account-wide MFA gate (403 + code account_mfa_required): the one
      // actionable authz denial — the user can complete an MFA challenge and
      // retry. Surface it as a browser event so the app's step-up dialog opens
      // no matter which call site tripped the gate. No-op outside the browser.
      if (
        response.status === 403 &&
        errorData?.code === 'account_mfa_required' &&
        typeof window !== 'undefined' &&
        typeof window.dispatchEvent === 'function'
      ) {
        try {
          window.dispatchEvent(new CustomEvent('kortix:mfa-required'));
        } catch {
          // Never let telemetry-grade signaling break the error path.
        }
      }

      // Handle HTTP 431 - Request Header Fields Too Large
      // This typically happens when uploading many files at once
      if (response.status === 431) {
        error = new RequestTooLargeError(431, {
          message: 'Request is too large to process',
          suggestion: 'Try uploading files one at a time, or reduce the number of files attached to your message.',
        });
      }

      // Expected "feature not enabled on this deployment" state — the backend
      // returns a TYPED 501 with `code: 'feature_not_supported'` (see the
      // executor router's `featureNotSupportedResponse`) when an OPTIONAL
      // capability isn't wired on this deployment (e.g. connector
      // auth-discovery, Pipedream). The dashboard already surfaces these as a
      // graceful "unavailable" UI state (e.g. the connector-auth-discovery
      // InfoBanner), so they must NEVER page Better Stack — a bare 501
      // "not supported" previously leaked as an opaque `ApiError` in Sentry
      // (pattern `1f3c4d96…`). Treat it as SILENT here: skip the global
      // `onError` (Sentry) capture, but still return the `ApiError` so callers
      // (React Query `onError` / the UI) can branch on `.code ===
      // 'feature_not_supported'`. A genuine 501 server bug carries no such
      // code and still reports normally. Mirrors the expected-state
      // classification used for billing-gate 402s and the no-compaction-model
      // sentinel (PR #5183): a typed code distinguishes "deployment doesn't
      // offer this" from a real defect.
      const isFeatureNotSupported =
        response.status === 501 && errorData?.code === FEATURE_NOT_SUPPORTED_CODE;

      // Expected "this model isn't available for this account" state — the
      // backend returns a TYPED 409 with `code: 'model_not_servable'` (from
      // `isModelServableForAccount` in `apps/api/src/projects/routes/r4.ts` and
      // `channel-bindings.ts`) when a user picks a model their account can't
      // use (free-tier managed model, disconnected BYOK provider). This is a UI
      // validation error, not a server defect, so it must NEVER page Better
      // Stack — a bare `ApiError: Model "…" is not available for this account`
      // previously leaked to Sentry as an unhandled-looking rejection (pattern
      // `ed07f6c5…`) because the model-defaults `useMutation` had no `onError`
      // and the call sites fire-and-forget the promise. Treat it as SILENT
      // here: skip `onError` (Sentry), but still return the `ApiError` so the
      // `useModelDefaults` `setMutation` `onError` can branch on `.code ===
      // 'model_not_servable'` and show a user-facing toast. A genuine 409 (no
      // typed code) still reports. Same shape as `isFeatureNotSupported`.
      const isModelNotServable =
        response.status === 409 && errorData?.code === MODEL_NOT_SERVABLE_CODE;

      if (showErrors && !isFeatureNotSupported && !isModelNotServable) {
        platformConfig().onError?.(error, errorContext);
      }

      return {
        error,
        success: false,
      };
    }

    let data: T;
    const contentType = response.headers.get('content-type');

    if (contentType?.includes('application/json')) {
      data = await response.json();
    } else if (contentType?.includes('text/')) {
      data = await response.text() as T;
    } else {
      data = await response.blob() as T;
    }

    return {
      data,
      success: true,
    };

  } catch (error: any) {
    // Always clear timeout on error
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }

    // Check if this is an abort error (timeout or manual abort)
    const requestWasAborted = isAbortError(error);

    // If it was aborted, mark it so we don't try to abort again
    if (requestWasAborted) {
      isAborted = true;
    }

    let apiError: ApiError;

    if (requestWasAborted) {
      // An external abort (Next.js client navigation, tab close, React Query
      // cancelling an in-flight request, a dropped connection) is NOT a
      // timeout — surfacing it as one produced the mysterious, URL-less
      // "Request timeout" toasts/Sentry events. Swallow it silently.
      if (!didTimeout) {
        return {
          error: new ApiError('Request aborted', { name: 'AbortError', code: 'ABORTED' }),
          success: false,
        };
      }

      // Genuine timeout — our timer fired. Attach the endpoint so it's clear
      // *what* timed out (the previous error carried no URL).
      const endpoint = url.replace(getApiUrl(), '') || url;
      apiError = new ApiError(`Request timed out after ${Math.round(timeout / 1000)}s: ${endpoint}`, {
        code: 'TIMEOUT',
        url,
        endpoint,
        timeout,
      });

      // Only show timeout errors if showErrors is true
      // This prevents spam from multiple concurrent timeouts or React Query cancellations
      if (showErrors) {
        platformConfig().onError?.(apiError, errorContext);
      }
    } else if (error instanceof Error) {
      apiError = new ApiError(error.message, {
        name: error.name || 'ApiError',
        stack: error.stack,
      });

      if (showErrors) {
        platformConfig().onError?.(apiError, errorContext);
      }
    } else {
      apiError = new ApiError(String(error));

      if (showErrors) {
        platformConfig().onError?.(apiError, errorContext);
      }
    }

    return {
      error: apiError,
      success: false,
    };
  }
}

export const supabaseClient = {
  async execute<T = any>(
    queryFn: () => Promise<{ data: T | null; error: any }>,
    errorContext?: ErrorContext
  ): Promise<ApiResponse<T>> {
    try {
      const { data, error } = await queryFn();

      if (error) {
        const apiError: ApiError = new ApiError(error.message || 'Database error', {
          code: error.code,
          details: error,
        });

        platformConfig().onError?.(apiError, errorContext);

        return {
          error: apiError,
          success: false,
        };
      }

      return {
        data: data as T,
        success: true,
      };
    } catch (error: any) {
      const apiError: ApiError = error instanceof Error
        ? new ApiError(error.message, { name: error.name || 'ApiError', stack: error.stack })
        : new ApiError(String(error));

      platformConfig().onError?.(apiError, errorContext);

      return {
        error: apiError,
        success: false,
      };
    }
  },
};

export const backendApi = {
  get: <T = any>(endpoint: string, options?: Omit<RequestInit & ApiClientOptions, 'method' | 'body'>) =>
    makeRequest<T>(`${getApiUrl()}${endpoint}`, { ...options, method: 'GET' }),

  post: <T = any>(endpoint: string, data?: any, options?: Omit<RequestInit & ApiClientOptions, 'method'>) =>
    makeRequest<T>(`${getApiUrl()}${endpoint}`, {
      ...options,
      method: 'POST',
      body: data ? JSON.stringify(data) : undefined,
    }),

  put: <T = any>(endpoint: string, data?: any, options?: Omit<RequestInit & ApiClientOptions, 'method'>) =>
    makeRequest<T>(`${getApiUrl()}${endpoint}`, {
      ...options,
      method: 'PUT',
      body: data ? JSON.stringify(data) : undefined,
    }),

  patch: <T = any>(endpoint: string, data?: any, options?: Omit<RequestInit & ApiClientOptions, 'method'>) =>
    makeRequest<T>(`${getApiUrl()}${endpoint}`, {
      ...options,
      method: 'PATCH',
      body: data ? JSON.stringify(data) : undefined,
    }),

  delete: <T = any>(endpoint: string, options?: Omit<RequestInit & ApiClientOptions, 'method' | 'body'>) =>
    makeRequest<T>(`${getApiUrl()}${endpoint}`, { ...options, method: 'DELETE' }),

  upload: <T = any>(endpoint: string, formData: FormData, options?: Omit<RequestInit & ApiClientOptions, 'method' | 'body'>) => {
    const { headers, ...restOptions } = options || {};
    const uploadHeaders = { ...headers as Record<string, string> };
    delete uploadHeaders['Content-Type'];

    return makeRequest<T>(`${getApiUrl()}${endpoint}`, {
      ...restOptions,
      method: 'POST',
      body: formData,
      headers: uploadHeaders,
    });
  },

  uploadPut: <T = any>(endpoint: string, formData: FormData, options?: Omit<RequestInit & ApiClientOptions, 'method' | 'body'>) => {
    const { headers, ...restOptions } = options || {};
    const uploadHeaders = { ...headers as Record<string, string> };
    delete uploadHeaders['Content-Type'];

    return makeRequest<T>(`${getApiUrl()}${endpoint}`, {
      ...restOptions,
      method: 'PUT',
      body: formData,
      headers: uploadHeaders,
    });
  },
};
