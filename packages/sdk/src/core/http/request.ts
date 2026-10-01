import { abortable, abortableDelay, createAbortError } from './abort';
import type { ApiClientOptions, ApiResponse } from './api-client';
import { ApiError, AuthError } from './api/errors';
import { platformConfig } from './config';
import { handleErrorResponse } from './response-error';
import { send } from './transport';

const getApiUrl = () => platformConfig().backendUrl || '';

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

/** A DELETE that fails at the TRANSPORT layer (fetch throws, no HTTP response)
 *  never reached the server as a completed request, so replaying it is safe —
 *  the server never confirmed it applied the delete. Kortix DELETEs are
 *  idempotent by design (a soft-tombstone stamp, then 404 for an already-absent
 *  row), so a replay re-tombstones (a no-op) or 404s. This is retried ONLY on a
 *  transport failure, NEVER on a received response status, where the server may
 *  already have applied the delete. Regression: incident-20260922T210537Z (a
 *  `sessions rm` DELETE stalled once, got zero retries, and blew past the
 *  heartbeat runner's 120s wall; a fresh retry deleted the session in ~1.1s). */
const isRetryableOnTransportFailure = (method?: string): boolean =>
  isIdempotentMethod(method) || (method ?? 'GET').toUpperCase() === 'DELETE';

const TRANSIENT_READ_RETRIES = 2;

const isAbortError = (error: unknown): boolean =>
  (error as { name?: string } | null)?.name === 'AbortError' ||
  (error as { name?: string } | null)?.name === 'AbortSignal' ||
  (error instanceof Error && error.message.includes('aborted'));

export async function makeRequest<T = any>(
  url: string,
  options: RequestInit & ApiClientOptions = {},
): Promise<ApiResponse<T>> {
  const {
    showErrors = true,
    errorContext,
    timeout = 30000,
    deadlineCoversBody = false,
    ...fetchOptions
  } = options;
  const controller = new AbortController();
  const state: RequestState = {
    activeController: controller,
    timeoutId: null,
    isAborted: false,
    didTimeout: false,
  };
  const abortFromCaller = () => state.activeController.abort();
  fetchOptions.signal?.addEventListener('abort', abortFromCaller, { once: true });
  try {
    return await executeRequest<T>(
      url,
      fetchOptions,
      showErrors,
      errorContext,
      timeout,
      deadlineCoversBody,
      controller,
      state,
    );
  } finally {
    fetchOptions.signal?.removeEventListener('abort', abortFromCaller);
  }
}

interface RequestState {
  activeController: AbortController;
  timeoutId: ReturnType<typeof setTimeout> | null;
  isAborted: boolean;
  didTimeout: boolean;
}

async function executeRequest<T>(
  url: string,
  fetchOptions: RequestInit,
  showErrors: boolean,
  errorContext: ApiClientOptions['errorContext'],
  timeout: number,
  deadlineCoversBody: boolean,
  controller: AbortController,
  state: RequestState,
): Promise<ApiResponse<T>> {
  try {
    if (fetchOptions.signal?.aborted) throw createAbortError();
    state.timeoutId = setTimeout(() => {
      if (!state.isAborted && !controller.signal.aborted) {
        state.isAborted = true;
        state.didTimeout = true;
        controller.abort();
      }
    }, timeout);
    const headers: Record<string, string> = {
      ...(fetchOptions.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(fetchOptions.headers as Record<string, string>),
    };

    const response = await retryRequest(
      url,
      fetchOptions,
      headers,
      timeout,
      deadlineCoversBody,
      controller,
      state,
    );
    if (response instanceof AuthError) return { error: response, success: false };
    if (!response.ok) {
      return handleErrorResponse(response, state.activeController.signal, showErrors, errorContext);
    }

    let data: T;
    const contentType = response.headers.get('content-type');

    if (contentType?.includes('application/json')) {
      data = await abortable(response.json(), state.activeController.signal);
    } else if (contentType?.includes('text/')) {
      data = (await abortable(response.text(), state.activeController.signal)) as T;
    } else {
      data = (await abortable(response.blob(), state.activeController.signal)) as T;
    }

    return {
      data,
      success: true,
      headers: response.headers,
    };
  } catch (error) {
    return handleRequestFailure(
      error,
      url,
      fetchOptions.method,
      showErrors,
      errorContext,
      timeout,
      state,
    );
  } finally {
    clearDeadline(state);
  }
}

function clearDeadline(state: RequestState): void {
  if (state.timeoutId) clearTimeout(state.timeoutId);
  state.timeoutId = null;
}

async function discardRetryResponse(
  response: Response,
  signal: AbortSignal,
  state: RequestState,
): Promise<void> {
  try {
    await abortable(response.arrayBuffer(), signal);
  } catch (error) {
    if (isAbortError(error)) throw error;
  } finally {
    clearDeadline(state);
  }
}

async function retryRequest(
  url: string,
  fetchOptions: RequestInit,
  headers: Record<string, string>,
  timeout: number,
  deadlineCoversBody: boolean,
  controller: AbortController,
  state: RequestState,
): Promise<Response | AuthError> {
  const retryableRead = isIdempotentMethod(fetchOptions.method);
  const retryableTransport = isRetryableOnTransportFailure(fetchOptions.method);
  const maxAttempts = retryableTransport ? TRANSIENT_READ_RETRIES + 1 : 1;
  let response!: Response;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      await abortableDelay(250 * 2 ** (attempt - 1), fetchOptions.signal ?? undefined);
    }

    const attemptController = attempt === 0 ? controller : new AbortController();
    state.activeController = attemptController;
    if (fetchOptions.signal?.aborted) attemptController.abort();
    if (attempt > 0) {
      state.timeoutId = setTimeout(() => {
        state.didTimeout = true;
        attemptController.abort();
      }, timeout);
    }

    try {
      response = await abortable(
        send(
          url,
          {
            ...fetchOptions,
            headers,
            signal: attemptController.signal,
            credentials: fetchOptions.credentials ?? 'omit',
          },
          { timeoutMs: null },
        ),
        attemptController.signal,
      );
    } catch (error) {
      if (state.timeoutId) {
        clearTimeout(state.timeoutId);
        state.timeoutId = null;
      }
      if (error instanceof AuthError) {
        return new AuthError();
      }
      const selfTimedOut = state.didTimeout && isAbortError(error) && !fetchOptions.signal?.aborted;
      if (selfTimedOut && retryableTransport && attempt < maxAttempts - 1) {
        state.didTimeout = false;
        continue;
      }
      if (isAbortError(error) || attempt === maxAttempts - 1) {
        throw error;
      }
      continue;
    }

    if (
      !retryableRead ||
      !isTransientGatewayStatus(response.status) ||
      attempt === maxAttempts - 1
    ) {
      if (!deadlineCoversBody) clearDeadline(state);
      return response;
    }
    await discardRetryResponse(response, attemptController.signal, state);
  }

  return response;
}

function handleRequestFailure(
  error: unknown,
  url: string,
  method: string | undefined,
  showErrors: boolean,
  errorContext: ApiClientOptions['errorContext'],
  timeout: number,
  state: RequestState,
): ApiResponse {
  clearDeadline(state);
  const requestWasAborted = isAbortError(error);
  if (requestWasAborted) {
    state.isAborted = true;
  }

  let apiError: ApiError;

  if (requestWasAborted) {
    if (!state.didTimeout) {
      return {
        error: new ApiError('Request aborted', {
          name: 'AbortError',
          code: 'ABORTED',
        }),
        success: false,
      };
    }
    const endpoint = url.replace(getApiUrl(), '') || url;
    apiError = new ApiError(`Request timed out after ${Math.round(timeout / 1000)}s: ${endpoint}`, {
      code: 'TIMEOUT',
      url,
      endpoint,
      timeout,
    });
  } else if (error instanceof Error) {
    apiError = new ApiError(
      method === 'POST' && error instanceof TypeError && error.message === 'Failed to fetch'
        ? `Failed to fetch: POST ${url.replace(getApiUrl(), '') || url}`
        : error.message,
      { name: error.name || 'ApiError', stack: error.stack },
    );

    if (showErrors) {
      platformConfig().onError?.(apiError, errorContext);
    }
  } else {
    apiError = new ApiError(String(error));

    if (showErrors) {
      platformConfig().onError?.(apiError, errorContext);
    }
  }

  return { error: apiError, success: false };
}
