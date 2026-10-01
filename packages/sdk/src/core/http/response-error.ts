import { abortable, createAbortError } from './abort';
import {
  ACCOUNTS_LIST_UNAVAILABLE_CODE,
  ANALYTICS_UNAVAILABLE_CODE,
  FEATURE_NOT_SUPPORTED_CODE,
  MODEL_NOT_SERVABLE_CODE,
  PROVISION_IN_FLIGHT_CODE,
} from './api-client';
import type { ApiResponse, ErrorContext } from './api-client';
import { ApiError, RequestTooLargeError, parseBillingError } from './api/errors';
import { platformConfig } from './config';

const REQUEST_DEADLINE_CODE = 'request_deadline';
const LEGACY_REQUEST_DEADLINE_MESSAGE = /^Request exceeded the \d+s server processing deadline$/;

const isRequestDeadlineResponse = (
  status: number,
  errorData: unknown,
  message: string,
): boolean => {
  if (status !== 503) return false;
  const code =
    typeof errorData === 'object' && errorData !== null && 'code' in errorData
      ? (errorData as { code?: unknown }).code
      : undefined;
  return code === REQUEST_DEADLINE_CODE || LEGACY_REQUEST_DEADLINE_MESSAGE.test(message);
};

/**
 * Stable error code the platform API returns (HTTP 503) when a project's git
 * mirror cold-clone/fetch fails for a TRANSIENT, retryable upstream reason
 * (GitHub edge blip, a momentarily unusable private-mirror credential, a
 * mid-transfer timeout). The API already classifies the cause out of its OWN
 * Sentry (`apps/api/src/projects/git/mirror.ts`'s `isTransientGitMirrorError`)
 * and answers a clean 503 + `Retry-After`; this is the frontend mirror.
 *
 * The 503 RESPONSE crosses the boundary: `makeRequest` extracts the message
 * and calls `onError` → the web host's `handleApiError`, which captures every
 * 5xx to the FRONTEND Sentry (app 2346967 — a SEPARATE app from the API's
 * 2346961). That is exactly how Better Stack frontend pattern `b4d05df2…`
 * (`ApiError: git mirror is temporarily unavailable`, on a session start that
 * cold-clones the project mirror) reached the frontend telemetry. Treat it as
 * SILENT here — skip the global `onError` (Sentry) capture — but still return
 * the `ApiError` so callers can branch on `.code`. A genuine 503 with another
 * message/code still reports.
 *
 * Must stay in sync with `GIT_MIRROR_UNAVAILABLE_CODE` in
 * `apps/api/src/projects/git/mirror.ts`. `LEGACY_GIT_MIRROR_UNAVAILABLE_MESSAGE`
 * covers a response from an API deployed before the typed code (the same
 * rollout shim as `LEGACY_REQUEST_DEADLINE_MESSAGE`).
 */
const GIT_MIRROR_UNAVAILABLE_CODE = 'git_mirror_unavailable';
const LEGACY_GIT_MIRROR_UNAVAILABLE_MESSAGE = /^git mirror is temporarily unavailable$/;

const isGitMirrorUnavailableResponse = (
  status: number,
  errorData: unknown,
  message: string,
): boolean => {
  if (status !== 503) return false;
  const code =
    typeof errorData === 'object' && errorData !== null && 'code' in errorData
      ? (errorData as { code?: unknown }).code
      : undefined;
  return (
    code === GIT_MIRROR_UNAVAILABLE_CODE || LEGACY_GIT_MIRROR_UNAVAILABLE_MESSAGE.test(message)
  );
};

async function readErrorBody(
  response: Response,
  signal: AbortSignal,
): Promise<{ message: string; data: any }> {
  let message = `HTTP ${response.status}: ${response.statusText}`;
  let data: any = null;
  try {
    data = await abortable(response.json(), signal);
    // Human-readable prose wins over machine reason slugs.
    if (typeof data.message === 'string') message = data.message;
    else if (data.error && typeof data.error === 'string') message = data.error;
    else if (typeof data.detail === 'string') message = data.detail;
    else if (typeof data.detail?.message === 'string') message = data.detail.message;
    else if (typeof data.reason === 'string') message = data.reason;
  } catch {}
  if (signal.aborted) throw createAbortError();
  return { message, data };
}

function isExpectedResponse(status: number, data: any, message: string): boolean {
  return (
    isRequestDeadlineResponse(status, data, message) ||
    isGitMirrorUnavailableResponse(status, data, message) ||
    (status === 501 && data?.code === FEATURE_NOT_SUPPORTED_CODE) ||
    (status === 409 &&
      (data?.code === MODEL_NOT_SERVABLE_CODE || data?.code === PROVISION_IN_FLIGHT_CODE)) ||
    (status === 503 &&
      (data?.code === ANALYTICS_UNAVAILABLE_CODE || data?.code === ACCOUNTS_LIST_UNAVAILABLE_CODE))
  );
}

export async function handleErrorResponse<T>(
  response: Response,
  signal: AbortSignal,
  showErrors: boolean,
  errorContext?: ErrorContext,
): Promise<ApiResponse<T>> {
  const { message, data } = await readErrorBody(response, signal);
  let error: ApiError | Error = new ApiError(message, {
    status: response.status,
    response,
    details: data || undefined,
    data,
    detail: data?.detail,
    code: isRequestDeadlineResponse(response.status, data, message)
      ? REQUEST_DEADLINE_CODE
      : data?.code || data?.error_code || data?.detail?.error_code || response.status.toString(),
  });
  if (response.status === 402) error = parseBillingError(error);
  if (
    response.status === 403 &&
    data?.code === 'account_mfa_required' &&
    typeof window !== 'undefined' &&
    typeof window.dispatchEvent === 'function'
  ) {
    try {
      window.dispatchEvent(new CustomEvent('kortix:mfa-required'));
    } catch {}
  }
  if (response.status === 431) {
    error = new RequestTooLargeError(431, {
      message: 'Request is too large to process',
      suggestion:
        'Try uploading files one at a time, or reduce the number of files attached to your message.',
    });
  }
  if (showErrors && !isExpectedResponse(response.status, data, message)) {
    platformConfig().onError?.(error, errorContext);
  }
  return { error, success: false };
}
