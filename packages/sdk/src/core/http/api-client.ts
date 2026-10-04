import { syntheticUnauthenticatedResponse } from '../../platform/auth-core';
import { ApiError, AuthError } from './api/errors';
import { platformConfig } from './config';
import { makeRequest } from './request';
import { send } from './transport';

export { isAdminBypassEnabled, setAdminBypass } from './transport';

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
  FEATURE_DISABLED_CODE,
  isFeatureDisabledError,
  featureDisabledKey,
  type ApiErrorFields,
  type BillingErrorUI,
  type FeatureDisabledError,
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
  /**
   * Keep `timeout` running until the response body is read. By default the
   * deadline stops when headers arrive, so a large body is never cut off.
   * Set it for requests whose server may stall after sending headers.
   */
  deadlineCoversBody?: boolean;
  /**
   * Override for the `fetch` implementation `backendApi.postStream` issues
   * the request with. Exists as an explicit injection point — not a global
   * (`globalThis.fetch = …`) — so a test (or a host with an unusual runtime)
   * can hand in a stub `Response` with a real streamed `ReadableStream` body
   * without touching the network. Ignored by `get`/`post`/`put`/`patch`/
   * `delete`/`upload`, which use `configureKortix({ fetch })`. Defaults to
   * `configureKortix({ fetch })`, then the global `fetch`.
   *
   * Deliberately narrower than `typeof fetch` (no `preconnect` static) so a
   * plain `async (input, init?) => new Response(...)` stub satisfies it
   * without also having to fake Bun's non-standard `fetch.preconnect`.
   */
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

export interface ApiResponse<T = any> {
  data?: T;
  error?: ApiError;
  success: boolean;
  /**
   * Response headers, on a successful response. Present so a surface can read a
   * value the API deliberately keeps OUT of the body — today that is
   * `X-Next-Cursor` on the session list, which pages without wrapping the array
   * in an envelope every existing client would have to relearn.
   */
  headers?: Headers;
}

/**
 * Stable error code the platform API returns (HTTP 501) when an OPTIONAL
 * capability isn't wired on the current deployment — e.g. connector
 * auth-discovery, Pipedream. `makeRequest` classifies a 501 carrying this code
 * as an EXPECTED "feature unavailable" state and drops it from Sentry; callers
 * branch on `err.code === FEATURE_NOT_SUPPORTED_CODE`. Must stay in sync with
 * `apps/api/src/http/connectors/router.ts`'s `FEATURE_NOT_SUPPORTED_CODE`.
 */
export const FEATURE_NOT_SUPPORTED_CODE = 'feature_not_supported';

/**
 * Stable error code the platform API returns (HTTP 409) when a user tries to
 * set a model their account can't use — e.g. a managed model on a free tier,
 * or a BYOK model whose provider isn't connected. The API emits this from the
 * model-defaults PUT (`apps/api/src/http/projects/models.ts`) and the channel
 * binding model set (`apps/api/src/http/projects/channel-bindings.ts`) via
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

/**
 * Stable error code the platform API returns (HTTP 409) when ANOTHER call
 * carrying the same `idempotency_key` is still mid-provision — see
 * `apps/api/src/services/projects/lib/provision-idempotency.ts`'s `in_flight` case and
 * the two `POST /projects/provision` handlers in
 * `apps/api/src/http/projects/projects.ts`. This is a RETRYABLE, EXPECTED state:
 * the concurrent attempt simply hasn't committed yet, and the caller retries
 * with the same key until it does. First-run onboarding hits it whenever a
 * second tab (or the other entry door) races the same auto-create, so it must
 * be SILENT to `onError` — otherwise the web host's global handler shows a red
 * toast reading "Another provision with this idempotency_key is in flight",
 * leaking an internal field name for a state that resolves on its own. The
 * `ApiError` is still returned so callers can branch on `.code` (see
 * `apps/web/src/lib/onboarding/ensure-first-project.ts`'s
 * `isProvisionInFlightError`). A genuine 409 (no typed code) still reports.
 * Mirrors `MODEL_NOT_SERVABLE_CODE`.
 */
export const PROVISION_IN_FLIGHT_CODE = 'provision_in_flight';

/**
 * Stable error code the platform API returns (HTTP 503) when the admin
 * analytics credit-ledger aggregate cannot complete inside the database
 * statement budget — in practice a `statement_timeout` (SQLSTATE 57014) on the
 * `kortix.credit_ledger` platform-wide scan behind
 * `GET /v1/admin/analytics/usage`. This is an EXPECTED capacity state for a
 * large ledger, not a server defect, so it must NEVER page Better Stack — the
 * raw `Failed query: select …` message previously leaked into the 500 body and
 * reached Sentry as an opaque `ApiError` (pattern `0e4ee10d…`). `makeRequest`
 * classifies a 503 carrying this code as SILENT to `onError` (Sentry) but still
 * returns the `ApiError`, so the dashboard can render its own unavailable
 * state. A genuine 503 (no typed code) still reports. Must stay in sync with
 * `ANALYTICS_UNAVAILABLE_CODE` in apps/api/src/http/admin/analytics.ts.
 */
export const ANALYTICS_UNAVAILABLE_CODE = 'analytics_unavailable';

/**
 * Stable error code the platform API returns (HTTP 503) when the admin
 * accounts-list query (`GET /v1/admin/api/accounts` — the admin console's
 * `/admin/accounts` page) cannot complete inside the database statement
 * budget — in practice a `statement_timeout` (SQLSTATE 57014) on the
 * `kortix.accounts LEFT JOIN kortix.credit_accounts` scan. This is an
 * EXPECTED capacity state, not a server defect, so it must NEVER page Better
 * Stack — the raw `Failed query: select … "kortix"."credit_accounts".
 * "balance_precise" …` message previously leaked into the 500 body (prod,
 * 2026-09-27, 25013/25019/25056 ms against the 25s budget). `makeRequest`
 * classifies a 503 carrying this code as SILENT to `onError` (Sentry) but
 * still returns the `ApiError`, so the console can render its own
 * unavailable state. A genuine 503 (no typed code) still reports. Must stay
 * in sync with `ACCOUNTS_LIST_UNAVAILABLE_CODE` in
 * apps/api/src/http/admin/index.ts. Mirrors `ANALYTICS_UNAVAILABLE_CODE`.
 */
export const ACCOUNTS_LIST_UNAVAILABLE_CODE = 'accounts_list_unavailable';

export const supabaseClient = {
  async execute<T = any>(
    queryFn: () => Promise<{ data: T | null; error: any }>,
    errorContext?: ErrorContext,
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
      const apiError: ApiError =
        error instanceof Error
          ? new ApiError(error.message, {
              name: error.name || 'ApiError',
              stack: error.stack,
            })
          : new ApiError(String(error));

      platformConfig().onError?.(apiError, errorContext);

      return {
        error: apiError,
        success: false,
      };
    }
  },
};

/**
 * Streaming POST — bypasses `makeRequest`'s single-shot body consumption
 * (`.json()`/`.text()`/`.blob()`, which can only run once) and hands back
 * the raw `Response` so a caller can read `response.body` incrementally as
 * Server-Sent-Event frames arrive. No transient retry (POST is not
 * retryable), no automatic body parsing.
 *
 * Auth and headers come from `send`, as for every other backend request. A
 * missing token resolves a synthetic 401 without a request, so "no token yet"
 * and a server 401 reach the caller the same way: a non-ok `Response`.
 *
 * `timeout` bounds only the initial connect/response-headers exchange (as
 * `fetch()`'s promise settles), not how long the stream stays open —
 * provisioning can legitimately take longer than one request timeout while
 * it reports progress frames.
 */
async function postStream(
  endpoint: string,
  data: unknown,
  options: ApiClientOptions = {},
): Promise<Response> {
  const { timeout = 30000, fetch: fetchImpl } = options;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  try {
    return await send(
      `${getApiUrl()}${endpoint}`,
      {
        method: 'POST',
        headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        signal: controller.signal,
        credentials: 'omit',
      },
      { timeoutMs: null, fetch: fetchImpl },
    );
  } catch (error) {
    if (error instanceof AuthError) return syntheticUnauthenticatedResponse();
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

export const backendApi = {
  /** Send bytes through the same auth, impersonation, cancellation and error seam. */
  putRaw: <T = any>(
    endpoint: string,
    body: BodyInit,
    options?: Omit<RequestInit & ApiClientOptions, 'method' | 'body'>,
  ) =>
    makeRequest<T>(`${getApiUrl()}${endpoint}`, {
      ...options,
      method: 'PUT',
      body,
      headers: { 'Content-Type': 'application/octet-stream', ...options?.headers },
    }),
  get: <T = any>(
    endpoint: string,
    options?: Omit<RequestInit & ApiClientOptions, 'method' | 'body'>,
  ) => makeRequest<T>(`${getApiUrl()}${endpoint}`, { ...options, method: 'GET' }),

  post: <T = any>(
    endpoint: string,
    data?: any,
    options?: Omit<RequestInit & ApiClientOptions, 'method'>,
  ) =>
    makeRequest<T>(`${getApiUrl()}${endpoint}`, {
      ...options,
      method: 'POST',
      body: data ? JSON.stringify(data) : undefined,
    }),

  put: <T = any>(
    endpoint: string,
    data?: any,
    options?: Omit<RequestInit & ApiClientOptions, 'method'>,
  ) =>
    makeRequest<T>(`${getApiUrl()}${endpoint}`, {
      ...options,
      method: 'PUT',
      body: data ? JSON.stringify(data) : undefined,
    }),

  patch: <T = any>(
    endpoint: string,
    data?: any,
    options?: Omit<RequestInit & ApiClientOptions, 'method'>,
  ) =>
    makeRequest<T>(`${getApiUrl()}${endpoint}`, {
      ...options,
      method: 'PATCH',
      body: data ? JSON.stringify(data) : undefined,
    }),

  delete: <T = any>(
    endpoint: string,
    options?: Omit<RequestInit & ApiClientOptions, 'method' | 'body'>,
  ) =>
    makeRequest<T>(`${getApiUrl()}${endpoint}`, {
      ...options,
      method: 'DELETE',
    }),

  upload: <T = any>(
    endpoint: string,
    formData: FormData,
    options?: Omit<RequestInit & ApiClientOptions, 'method' | 'body'>,
  ) => {
    const { headers, ...restOptions } = options || {};
    const uploadHeaders = { ...(headers as Record<string, string>) };
    delete uploadHeaders['Content-Type'];

    return makeRequest<T>(`${getApiUrl()}${endpoint}`, {
      ...restOptions,
      method: 'POST',
      body: formData,
      headers: uploadHeaders,
    });
  },

  uploadPut: <T = any>(
    endpoint: string,
    formData: FormData,
    options?: Omit<RequestInit & ApiClientOptions, 'method' | 'body'>,
  ) => {
    const { headers, ...restOptions } = options || {};
    const uploadHeaders = { ...(headers as Record<string, string>) };
    delete uploadHeaders['Content-Type'];

    return makeRequest<T>(`${getApiUrl()}${endpoint}`, {
      ...restOptions,
      method: 'PUT',
      body: formData,
      headers: uploadHeaders,
    });
  },

  postStream,
};
