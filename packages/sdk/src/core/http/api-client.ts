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

    const response = await fetch(url, {
      ...fetchOptions,
      headers,
      signal: controller.signal,
      // API auth is bearer-token based. Don't send browser cookies to the
      // same-origin /v1 proxy; large localhost cookie jars can trip HTTP 431
      // before the request reaches the API.
      credentials: fetchOptions.credentials ?? 'omit',
    });

    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }

    if (!response.ok) {
      let errorMessage = `HTTP ${response.status}: ${response.statusText}`;
      let errorData: any = null;

      try {
        errorData = await response.json();
        if (errorData.message) {
          errorMessage = errorData.message;
        } else if (errorData.error && typeof errorData.error === 'string') {
          errorMessage = errorData.error;
        } else if (typeof errorData.detail === 'string') {
          // FastAPI returns {"detail": "error message"}
          errorMessage = errorData.detail;
        } else if (errorData.detail?.message) {
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

      // Handle HTTP 431 - Request Header Fields Too Large
      // This typically happens when uploading many files at once
      if (response.status === 431) {
        error = new RequestTooLargeError(431, {
          message: 'Request is too large to process',
          suggestion: 'Try uploading files one at a time, or reduce the number of files attached to your message.',
        });
      }

      if (showErrors) {
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
    const isAbortError = error?.name === 'AbortError' ||
                         error?.name === 'AbortSignal' ||
                         (error instanceof Error && error.message.includes('aborted'));

    // If it was aborted, mark it so we don't try to abort again
    if (isAbortError) {
      isAborted = true;
    }

    let apiError: ApiError;

    if (isAbortError) {
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
