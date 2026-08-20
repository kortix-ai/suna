import type {
  GatewayAttemptFailure,
  GatewayConfig,
  GatewayLogger,
  ModelFallbackCondition,
  ModelGenerationDefaults,
  UpstreamDescriptor,
} from '../domain';
import {
  CircuitOpenError,
  ClientAbortError,
  NetworkError,
  TimeoutError,
  UpstreamHttpError,
  UpstreamMisconfiguredError,
  looksLikeTerminalAuthFailure,
} from '../errors';
import { type FetchImpl, callUpstream } from '../http';
import { parseUpstreamErrorBody } from '../http/parse-upstream-error';
import type { CircuitBreaker } from '../resilience';
import {
  MAX_RELAYED_RETRY_AFTER_SECONDS,
  clampRetryAfterSeconds,
  gatewayErrorBody,
} from './error-response';
import { appendAttemptFailure, failureChainMessage } from './failure-chain';
import { applyGenerationDefaults } from './generation-defaults';
import type { TraceEmitter, TraceFields } from './trace';

// 4xx statuses that mean "this upstream won't serve you right now" rather than
// "your request is wrong" — rate limit, payment required, quota/forbidden. These
// are the ones worth failing over (e.g. BYOK out of quota → managed fallback).
// One source of truth for "which 4xx fails over".
export const LIMIT_STATUSES = new Set([402, 403, 429]);

function json(data: unknown, status = 200, retryAfterSeconds?: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json',
      // Relayed only when the upstream sent one, and only ever clamped — see
      // `clampRetryAfterSeconds`. Without a clamp an upstream `Retry-After:
      // 2147483` would park OpenCode >= 1.18.17 for 24.8 days.
      ...(retryAfterSeconds !== undefined
        ? {
            'retry-after': String(
              Math.min(MAX_RELAYED_RETRY_AFTER_SECONDS, Math.max(1, Math.ceil(retryAfterSeconds))),
            ),
          }
        : {}),
    },
  });
}

/**
 * The upstream's `Retry-After` for a back-pressure status (429 / 503), clamped
 * to at most 60s. Any other status — and any absent, malformed, or non-positive
 * header — relays nothing, so the client falls back to its own backoff.
 */
function relayedRetryAfterSeconds(err: unknown, status: number): number | undefined {
  if (status !== 429 && status !== 503) return undefined;
  if (!(err instanceof UpstreamHttpError)) return undefined;
  const headers = err.headers;
  if (!headers) return undefined;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== 'retry-after') continue;
    return clampRetryAfterSeconds(value);
  }
  return undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Mines the REAL human-readable message + code from an upstream error's
// response body (the raw `UpstreamHttpError.body` the AI SDK populates with
// `responseBody`). Delegates to the shared `parseUpstreamErrorBody` so the
// non-streaming and streaming paths surface the same message for the same
// upstream failure — e.g. "context length exceeded from messages" instead of a
// generic "Bad Request"/"Bad Gateway" (2026-08-01 defect).
function parseUpstreamBody(body: string): { message: string; code?: string | number } {
  return parseUpstreamErrorBody(body);
}

function suggestionFor(status: number): string {
  if (status === 401 || status === 402 || status === 403) {
    return 'Check the provider credentials, billing, and model access, or switch to another model.';
  }
  if (status === 429) {
    return 'Retry after a short wait, or switch to another model.';
  }
  return 'Retry the request. If the error continues, switch to another model.';
}

export interface FailoverContext {
  /** The RAW request body — i.e. WITHOUT any project/account-configured
   *  generation defaults injected. Each candidate attempt layers in its OWN
   *  freshly-clamped defaults via `generationDefaultsForModel` below (see
   *  the loop) rather than trusting a single pre-baked payload for every
   *  candidate, which would silently forward the PRIMARY model's defaults
   *  (temperature, reasoning_effort, max_tokens) to a fallback candidate
   *  with different capabilities. */
  candidates: RoutedUpstreamCandidate[];
  payload: Record<string, unknown>;
  config: GatewayConfig;
  fetchImpl?: FetchImpl;
  breakerFor: (provider: string) => CircuitBreaker;
  emit: TraceEmitter;
  logger: GatewayLogger;
  requestId: string;
  trace: Partial<TraceFields>;
  capturedRequest: unknown;
  fallbackOn: ModelFallbackCondition;
  /** Inbound client's abort signal — aborts an in-flight candidate attempt
   *  immediately if the caller disconnects before any upstream is chosen. */
  signal?: AbortSignal;
  /** Re-derive `ModelGenerationDefaults` for a specific candidate's
   *  `routeModel` right before dispatch — see `ModelRoutePlan`'s doc
   *  comment (`domain/routing.ts`). Applied fresh per candidate via
   *  `applyGenerationDefaults` (explicit client values still win; only
   *  fields the client didn't already set get filled). Omitted entirely
   *  when the host configured no generation defaults at all. */
  generationDefaultsForModel?: (model: string) => ModelGenerationDefaults | undefined;
  /** Candidate failures already observed by an earlier validation pass. */
  attemptFailures?: GatewayAttemptFailure[];
}

export interface RoutedUpstreamCandidate {
  descriptor: UpstreamDescriptor;
  routeModel: string;
}

export interface FailoverSuccess {
  upstream: Response;
  chosen: RoutedUpstreamCandidate;
  tried: string[];
  modelsTried: string[];
  attempts: number;
  /** The ACTUAL payload sent to `chosen` — `ctx.payload` with `chosen`'s own
   *  freshly-clamped generation defaults layered in (see
   *  `generationDefaultsForModel`). Callers that need to know exactly what
   *  reached the wire (tracing/capture) should use this instead of
   *  `ctx.payload`. */
  dispatchedPayload: Record<string, unknown>;
  attemptFailures: GatewayAttemptFailure[];
}

export type FailoverResult =
  | { kind: 'response'; response: Response }
  | { kind: 'success'; value: FailoverSuccess };

export async function runFailover(ctx: FailoverContext): Promise<FailoverResult> {
  const {
    candidates,
    payload,
    config,
    fetchImpl,
    breakerFor,
    emit,
    logger,
    requestId,
    trace,
    capturedRequest,
    fallbackOn,
    signal,
    generationDefaultsForModel,
    attemptFailures: priorAttemptFailures,
  } = ctx;
  const attemptFailures = [...(priorAttemptFailures ?? [])];
  const tried: string[] = [];
  const modelsTried: string[] = [];
  let attempts = 0;
  let upstream: Response | null = null;
  let chosen: RoutedUpstreamCandidate | null = null;
  let dispatchedPayload: Record<string, unknown> = payload;
  let lastError: unknown;

  const debug = (event: string, fields?: Record<string, unknown>): void =>
    logger.debug?.(`[gateway] · ${requestId} ${event}`, { requestId, event, ...fields });

  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    const { descriptor, routeModel } = candidate;
    const hasFallback = i < candidates.length - 1;
    const hasModelFallback = candidates.slice(i + 1).some((next) => next.routeModel !== routeModel);
    const hasCredentialFallback = candidates.slice(i + 1).some(
      (next) =>
        next.routeModel === routeModel &&
        next.descriptor.provider === descriptor.provider &&
        descriptor.credentialRef !== undefined &&
        next.descriptor.credentialRef !== undefined &&
        next.descriptor.credentialRef !== descriptor.credentialRef,
    );
    tried.push(descriptor.provider);
    if (modelsTried.at(-1) !== routeModel) modelsTried.push(routeModel);
    attempts += 1;
    const breaker = breakerFor(descriptor.provider);
    const attemptStart = Date.now();
    debug('upstream_attempt', {
      candidate: i,
      provider: descriptor.provider,
      kind: descriptor.kind,
      resolvedModel: descriptor.resolvedModel,
      routeModel,
      baseUrl: descriptor.baseUrl,
      breakerState: breaker.current,
      hasFallback,
    });
    // Re-clamped for THIS candidate, never trusted from a prior candidate —
    // see FailoverContext.generationDefaultsForModel's doc comment. `payload`
    // itself carries no generation defaults (the host never bakes them in
    // before routing), so this is the ONLY place they're injected, and it
    // happens fresh for every candidate the loop tries.
    const candidatePayload = generationDefaultsForModel
      ? applyGenerationDefaults(payload, generationDefaultsForModel(routeModel))
      : payload;
    try {
      upstream = await callUpstream(candidatePayload, descriptor, {
        retry: {
          ...config.retry,
          onRetry: (info) => {
            attempts += 1;
            debug('upstream_retry', {
              provider: descriptor.provider,
              attempt: info.attempt,
              delayMs: info.delayMs,
              reason: errorMessage(info.error),
            });
            config.retry?.onRetry?.(info);
          },
        },
        binding: { provider: descriptor.provider, breaker },
        fetchImpl,
        signal,
        requestId,
      });
      chosen = candidate;
      dispatchedPayload = candidatePayload;
      debug('upstream_attempt_ok', {
        provider: descriptor.provider,
        status: upstream.status,
        ms: Date.now() - attemptStart,
      });
      break;
    } catch (err) {
      lastError = err;
      const upstreamError =
        err instanceof UpstreamHttpError
          ? parseUpstreamBody(err.body)
          : { message: errorMessage(err) };
      const errorKind =
        err instanceof ClientAbortError
          ? 'client_disconnected'
          : err instanceof TimeoutError
            ? 'upstream_timeout'
            : err instanceof CircuitOpenError
              ? 'circuit_open'
              : err instanceof UpstreamMisconfiguredError
                ? 'upstream_misconfigured'
                : err instanceof NetworkError
                  ? 'upstream_network_error'
                  : 'upstream_dispatch_error';
      appendAttemptFailure(attemptFailures, {
        provider: descriptor.provider,
        routeModel,
        resolvedModel: descriptor.resolvedModel,
        stage: 'dispatch',
        ...(err instanceof UpstreamHttpError ? { status: err.status } : {}),
        code: upstreamError.code ?? errorKind,
        message: upstreamError.message,
      });
      debug('upstream_attempt_failed', {
        provider: descriptor.provider,
        ms: Date.now() - attemptStart,
        status: err instanceof UpstreamHttpError ? err.status : undefined,
        error: errorMessage(err),
        breakerState: breaker.current,
      });
      if (err instanceof ClientAbortError) {
        // The caller is gone — trying the next candidate would only spend more
        // upstream tokens/money for a response no one will ever receive. Stop
        // the whole dispatch loop immediately instead of failing over.
        debug('client_aborted', { provider: descriptor.provider });
        emit({
          ...trace,
          resolvedModel: descriptor.resolvedModel,
          provider: descriptor.provider,
          billingMode: descriptor.billingMode,
          status: 499,
          ok: false,
          errorCode: 'client_disconnected',
          errorMessage: 'Client disconnected before a response was ready',
          attempts,
          candidatesTried: tried,
          attemptFailures,
          request: capturedRequest,
        });
        return {
          kind: 'response',
          // 499 (nginx's "client closed request") — there's no real HTTP
          // client left to observe this status, but it keeps the trace/logs
          // honest about why the dispatch loop stopped.
          response: json(
            gatewayErrorBody({
              message: 'Client disconnected before a response was ready',
              code: 'client_disconnected',
              provider: descriptor.provider,
              requestedModel: trace.requestedModel ?? '',
              resolvedModel: descriptor.resolvedModel ?? trace.requestedModel ?? '',
              requestId,
              suggestion: 'No action needed — the client already disconnected.',
              attemptFailures,
              responseStatus: 499,
            }),
            499,
          ),
        };
      }
      if (err instanceof UpstreamHttpError && err.status >= 400 && err.status < 500) {
        const credentialFailure =
          hasCredentialFallback &&
          (err.status === 401 ||
            (err.status === 400 &&
              looksLikeTerminalAuthFailure(
                `${upstreamError.message} ${upstreamError.code ?? ''}`,
              )));
        // A rate-limit / quota / billing error (429/402/403) on a candidate that
        // has a fallback behind it — e.g. a user's BYOK key out of quota, with a
        // managed model queued next — falls over instead of failing the turn.
        // (429 was already retried on this candidate by callUpstream, so reaching
        // here means it's persistent, not a transient blip.) Other 4xx — bad
        // here means it is persistent. Authentication failures advance only
        // when the same route has another configured credential. Other 4xx
        // responses return unchanged.
        if (
          credentialFailure ||
          (LIMIT_STATUSES.has(err.status) && hasFallback) ||
          (fallbackOn === 'any-error' && hasModelFallback)
        ) {
          debug('failover_to_next', {
            fromProvider: descriptor.provider,
            fromModel: routeModel,
            status: err.status,
            reason:
              credentialFailure
                ? 'credential'
                : fallbackOn === 'any-error' && hasModelFallback
                  ? 'model_policy'
                  : 'provider_limit',
          });
          continue;
        }
        debug('upstream_client_error_return', {
          provider: descriptor.provider,
          status: err.status,
        });
        const clientErrorCode =
          upstreamError.code === 'context_length_exceeded'
            ? 'context_length_exceeded'
            : 'upstream_client_error';
        emit({
          ...trace,
          resolvedModel: descriptor.resolvedModel,
          provider: descriptor.provider,
          billingMode: descriptor.billingMode,
          status: err.status,
          ok: false,
          errorCode: clientErrorCode,
          errorMessage: upstreamError.message,
          attempts,
          candidatesTried: tried,
          attemptFailures,
          request: capturedRequest,
        });
        return {
          kind: 'response',
          response: json(
            gatewayErrorBody({
              message: upstreamError.message,
              code: clientErrorCode,
              upstreamCode:
                clientErrorCode === 'context_length_exceeded'
                  ? clientErrorCode
                  : upstreamError.code,
              upstreamStatus: err.status,
              provider: descriptor.provider,
              requestedModel: trace.requestedModel ?? '',
              resolvedModel: descriptor.resolvedModel ?? trace.requestedModel ?? '',
              requestId,
              suggestion:
                clientErrorCode === 'context_length_exceeded'
                  ? 'Compact the conversation or reduce the input, then retry.'
                  : suggestionFor(err.status),
              attemptFailures,
              // Below 500 this drops every per-attempt HTTP status from the
              // body. A permanent 400/401/403 that carried a prior candidate's
              // `status: 500` matched OpenCode >= 1.18.14's retry regex and was
              // replayed five times, re-sending the whole prompt each time.
              responseStatus: err.status,
            }),
            err.status,
            relayedRetryAfterSeconds(err, err.status),
          ),
        };
      }
    }
  }

  if (!upstream || !chosen) {
    const open = lastError instanceof CircuitOpenError;
    const status = open ? 503 : 502;
    const errorCode = open ? 'upstream_unavailable' : 'upstream_unreachable';
    const lastCandidate = [...candidates]
      .reverse()
      .find((candidate) => candidate.descriptor.provider === tried.at(-1));
    const lastDescriptor = lastCandidate?.descriptor;
    const upstreamError =
      lastError instanceof UpstreamHttpError
        ? parseUpstreamBody(lastError.body)
        : { message: errorMessage(lastError) };
    const message = failureChainMessage(
      attemptFailures,
      upstreamError.message || 'All upstreams unavailable',
      requestId,
    );
    debug('all_upstreams_exhausted', {
      circuitOpen: open,
      status,
      tried,
      attempts,
      error: message,
    });
    emit({
      ...trace,
      provider: tried[tried.length - 1] ?? '',
      status,
      ok: false,
      resolvedModel: lastDescriptor?.resolvedModel,
      errorCode,
      errorMessage: message,
      attempts,
      candidatesTried: tried,
      attemptFailures,
      request: capturedRequest,
    });
    return {
      kind: 'response',
      response: json(
        gatewayErrorBody({
          message,
          code: errorCode,
          upstreamCode: upstreamError.code,
          upstreamStatus: lastError instanceof UpstreamHttpError ? lastError.status : undefined,
          provider: lastDescriptor?.provider ?? tried.at(-1) ?? '',
          requestedModel: trace.requestedModel ?? '',
          resolvedModel: lastDescriptor?.resolvedModel ?? trace.requestedModel ?? '',
          requestId,
          suggestion: suggestionFor(
            lastError instanceof UpstreamHttpError ? lastError.status : status,
          ),
          attemptFailures,
          responseStatus: status,
        }),
        status,
        relayedRetryAfterSeconds(lastError, status),
      ),
    };
  }

  return {
    kind: 'success',
    value: {
      upstream,
      chosen,
      tried,
      modelsTried,
      attempts,
      dispatchedPayload,
      attemptFailures,
    },
  };
}
