import type { GatewayAttemptFailure } from '../domain';

// ---------------------------------------------------------------------------
// Why a sub-500 error body must not carry per-attempt HTTP statuses.
//
// OpenCode 1.18.14 REWROTE its retry classifier (verified by disassembling the
// 1.18.19 release binary, `SessionRetry`): the old JSON parse of the error
// message is gone, replaced by a regex list matched against BOTH
// `error.data.message` AND `error.data.responseBody` — i.e. against the RAW
// text of whatever body this function produced. The first pattern is
//
//     /429|500|502|503|504|524/i
//
// unanchored, with no word boundaries. `retryable()` returns "retry" when that
// matches, *regardless of the HTTP status*:
//
//     if (!isRetryable && !(statusCode >= 500) && !Ds(message) && !Ds(responseBody)) return;
//
// 1.18.17 then retries up to `RETRY_MAX_RETRIES = 5` times. So a PERMANENT
// 400/401/403 whose body happens to serialize a prior attempt's `status: 500`
// is replayed five times, re-sending the entire prompt on every replay (~$0.83
// of prefill per attempt at the context sizes this gateway sees).
//
// Fix: any body served with a status below 500 omits every gateway-authored
// numeric HTTP status. Bodies served with >= 500 keep them — OpenCode already
// retries those on the status alone, so hiding the diagnostics there buys
// nothing. The full, unredacted chain is always recorded on the trace
// (`TraceFields.attemptFailures` → Langfuse), which is where it is actually
// read when debugging.
//
// The gate is on `< 500`, not on the six trigger values, deliberately: the
// trigger list is OpenCode's and can grow (1.18.14 already added 524), so
// keying on it would rot on the next bump.
// ---------------------------------------------------------------------------

/** Upper bound the gateway relays for `Retry-After`, in seconds. */
export const MAX_RELAYED_RETRY_AFTER_SECONDS = 60;

export interface GatewayErrorContext {
  message: string;
  code: string;
  upstreamCode?: string | number;
  upstreamStatus?: number;
  provider: string;
  requestedModel: string;
  resolvedModel: string;
  requestId: string;
  suggestion: string;
  attemptFailures?: GatewayAttemptFailure[];
  /**
   * HTTP status this body will be sent with. Below 500 it suppresses every
   * gateway-authored numeric HTTP status in the body (see the note above).
   * Omitted means "not a client-facing HTTP response" (e.g. an in-stream SSE
   * error frame) and leaves the body unredacted.
   */
  responseStatus?: number;
  /**
   * Upstream `Retry-After`, in seconds, already clamped by
   * `clampRetryAfterSeconds`. Emitted as a response header by
   * `gatewayErrorResponse`; never serialized into the body.
   */
  retryAfterSeconds?: number;
}

function suppressesUpstreamStatuses(context: GatewayErrorContext): boolean {
  return context.responseStatus !== undefined && context.responseStatus < 500;
}

function wireAttemptFailure(
  failure: GatewayAttemptFailure,
  suppressStatuses: boolean,
): Record<string, unknown> {
  // An attempt `code` is the provider's own error code, but several providers
  // (and every SSE error frame carrying a numeric `code`) report it as the bare
  // HTTP status — the same three digits, in the same body. Collapse those to a
  // non-numeric code rather than leaving a second copy of the trigger behind.
  const code =
    suppressStatuses && typeof failure.code === 'number' ? 'upstream_error' : failure.code;
  return {
    attempt: failure.attempt,
    provider: failure.provider,
    route_model: failure.routeModel,
    resolved_model: failure.resolvedModel,
    stage: failure.stage,
    ...(failure.status !== undefined && !suppressStatuses ? { status: failure.status } : {}),
    code,
    message: failure.message,
  };
}

/**
 * Clamp an upstream `Retry-After` before relaying it.
 *
 * OpenCode 1.18.17 honours `Retry-After` / `retry-after-ms` VERBATIM whenever
 * the response carried headers, capped only by `RETRY_MAX_DELAY = 2147483647`
 * ms — 24.8 days. The 30s `RETRY_MAX_DELAY_NO_HEADERS` cap applies only when
 * there are no response headers at all. An upstream (or a hostile edge) that
 * answers `Retry-After: 86400` would therefore park a session for a day.
 *
 * Accepts the delta-seconds form and the HTTP-date form. Returns `undefined`
 * for an absent/unparseable/negative value; otherwise a whole number of
 * seconds in `[1, 60]`.
 */
export function clampRetryAfterSeconds(raw: string | undefined | null): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  const value = raw.trim();
  if (!value) return undefined;
  const seconds = Number.parseFloat(value);
  if (Number.isFinite(seconds)) {
    if (seconds <= 0) return undefined;
    return Math.min(MAX_RELAYED_RETRY_AFTER_SECONDS, Math.ceil(seconds));
  }
  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  const deltaSeconds = Math.ceil((at - Date.now()) / 1000);
  if (deltaSeconds <= 0) return undefined;
  return Math.min(MAX_RELAYED_RETRY_AFTER_SECONDS, deltaSeconds);
}

// OpenAI-compatible clients read `error.message`; generic HTTP clients commonly
// read top-level `message`/`code`. Keep both so no client has to fall back to the
// unhelpful HTTP status text (for example, "Bad Gateway").
export function gatewayErrorBody(context: GatewayErrorContext): Record<string, unknown> {
  const suppressStatuses = suppressesUpstreamStatuses(context);
  const attemptFailures = context.attemptFailures?.map((failure) =>
    wireAttemptFailure(failure, suppressStatuses),
  );
  // `upstream_status` and a numeric `upstream_code` describe the TERMINAL
  // failure — the one that produced the outer status — so on every path today
  // they equal `responseStatus` and add no digits the status line did not
  // already carry. Keep those (a 429 body that says `upstream_code: 429` tells
  // the client nothing new, and OpenCode retries a 429 on `isRetryable`
  // regardless). Drop only a value that DISAGREES with the outer status: that
  // is a foreign status, exactly the leak this gate exists to stop.
  const disagrees = (value: number | undefined): boolean =>
    value !== undefined && value !== context.responseStatus;
  const upstreamStatus =
    suppressStatuses && disagrees(context.upstreamStatus) ? undefined : context.upstreamStatus;
  const upstreamCode =
    suppressStatuses && typeof context.upstreamCode === 'number' && disagrees(context.upstreamCode)
      ? undefined
      : context.upstreamCode;
  const details = {
    message: context.message,
    type: context.code,
    code: upstreamCode ?? context.code,
    ...(upstreamStatus !== undefined ? { upstream_status: upstreamStatus } : {}),
    provider: context.provider,
    requested_model: context.requestedModel,
    resolved_model: context.resolvedModel,
    request_id: context.requestId,
    suggestion: context.suggestion,
    ...(attemptFailures?.length ? { attempt_failures: attemptFailures } : {}),
  };

  return {
    error: details,
    message: context.message,
    code: context.code,
    ...(upstreamCode ? { upstream_code: upstreamCode } : {}),
    ...(upstreamStatus !== undefined ? { upstream_status: upstreamStatus } : {}),
    provider: context.provider,
    requested_model: context.requestedModel,
    resolved_model: context.resolvedModel,
    request_id: context.requestId,
    suggestion: context.suggestion,
    ...(attemptFailures?.length ? { attempt_failures: attemptFailures } : {}),
  };
}

export function gatewayErrorResponse(status: number, context: GatewayErrorContext): Response {
  // `responseStatus` is filled in here rather than at every call site so no
  // caller can forget the gate: this function already knows the outer status.
  const withStatus: GatewayErrorContext = { ...context, responseStatus: status };
  const retryAfter = withStatus.retryAfterSeconds;
  return new Response(JSON.stringify(gatewayErrorBody(withStatus)), {
    status,
    headers: {
      'content-type': 'application/json',
      ...(retryAfter !== undefined
        ? { 'retry-after': String(Math.min(MAX_RELAYED_RETRY_AFTER_SECONDS, retryAfter)) }
        : {}),
    },
  });
}
