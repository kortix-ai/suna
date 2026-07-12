import type { GatewayConfig, GatewayLogger, UpstreamDescriptor } from '../domain';
import { CircuitOpenError, UpstreamHttpError } from '../errors';
import { type FetchImpl, callUpstream } from '../http';
import type { CircuitBreaker } from '../resilience';
import { gatewayErrorBody } from './error-response';
import type { TraceEmitter, TraceFields } from './trace';

// 4xx statuses that mean "this upstream won't serve you right now" rather than
// "your request is wrong" — rate limit, payment required, quota/forbidden. These
// are the ones worth failing over (e.g. BYOK out of quota → managed fallback).
const LIMIT_STATUSES = new Set([402, 403, 429]);

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseUpstreamBody(body: string): { message: string; code?: string } {
  if (!body) return { message: 'Upstream request failed' };
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const nested = parsed.error;
    if (typeof nested === 'string') {
      return { message: nested, code: typeof parsed.code === 'string' ? parsed.code : undefined };
    }
    if (nested && typeof nested === 'object') {
      const error = nested as Record<string, unknown>;
      return {
        message: typeof error.message === 'string' ? error.message : body,
        code:
          typeof error.code === 'string'
            ? error.code
            : typeof error.type === 'string'
              ? error.type
              : undefined,
      };
    }
    return {
      message: typeof parsed.message === 'string' ? parsed.message : body,
      code: typeof parsed.code === 'string' ? parsed.code : undefined,
    };
  } catch {
    return { message: body };
  }
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
  candidates: UpstreamDescriptor[];
  payload: Record<string, unknown>;
  config: GatewayConfig;
  fetchImpl?: FetchImpl;
  breakerFor: (provider: string) => CircuitBreaker;
  emit: TraceEmitter;
  logger: GatewayLogger;
  requestId: string;
  trace: Partial<TraceFields>;
  capturedRequest: unknown;
}

export interface FailoverSuccess {
  upstream: Response;
  chosen: UpstreamDescriptor;
  tried: string[];
  attempts: number;
}

export type FailoverResult = { kind: 'response'; response: Response } | { kind: 'success'; value: FailoverSuccess };

export async function runFailover(ctx: FailoverContext): Promise<FailoverResult> {
  const { candidates, payload, config, fetchImpl, breakerFor, emit, logger, requestId, trace, capturedRequest } = ctx;
  const tried: string[] = [];
  let attempts = 0;
  let upstream: Response | null = null;
  let chosen: UpstreamDescriptor | null = null;
  let lastError: unknown;

  const debug = (event: string, fields?: Record<string, unknown>): void =>
    logger.debug?.(`[gateway] · ${requestId} ${event}`, { requestId, event, ...fields });

  for (let i = 0; i < candidates.length; i += 1) {
    const descriptor = candidates[i];
    const hasFallback = i < candidates.length - 1;
    tried.push(descriptor.provider);
    attempts += 1;
    const breaker = breakerFor(descriptor.provider);
    const attemptStart = Date.now();
    debug('upstream_attempt', {
      candidate: i,
      provider: descriptor.provider,
      kind: descriptor.kind,
      resolvedModel: descriptor.resolvedModel,
      baseUrl: descriptor.baseUrl,
      breakerState: breaker.current,
      hasFallback,
    });
    try {
      upstream = await callUpstream(payload, descriptor, {
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
      });
      chosen = descriptor;
      debug('upstream_attempt_ok', {
        provider: descriptor.provider,
        status: upstream.status,
        ms: Date.now() - attemptStart,
      });
      break;
    } catch (err) {
      lastError = err;
      debug('upstream_attempt_failed', {
        provider: descriptor.provider,
        ms: Date.now() - attemptStart,
        status: err instanceof UpstreamHttpError ? err.status : undefined,
        error: errorMessage(err),
        breakerState: breaker.current,
      });
      if (err instanceof UpstreamHttpError && err.status >= 400 && err.status < 500) {
        // A rate-limit / quota / billing error (429/402/403) on a candidate that
        // has a fallback behind it — e.g. a user's BYOK key out of quota, with a
        // managed model queued next — falls over instead of failing the turn.
        // (429 was already retried on this candidate by callUpstream, so reaching
        // here means it's persistent, not a transient blip.) Other 4xx — bad
        // request, auth, model-not-found — are the caller's to fix: return as-is.
        if (LIMIT_STATUSES.has(err.status) && hasFallback) {
          debug('failover_to_next', { fromProvider: descriptor.provider, status: err.status });
          continue;
        }
        debug('upstream_client_error_return', { provider: descriptor.provider, status: err.status });
        const upstreamError = parseUpstreamBody(err.body);
        emit({
          ...trace, resolvedModel: descriptor.resolvedModel, provider: descriptor.provider,
          billingMode: descriptor.billingMode, status: err.status, ok: false,
          errorCode: 'upstream_client_error', errorMessage: upstreamError.message, attempts, candidatesTried: tried,
          request: capturedRequest,
        });
        return {
          kind: 'response',
          response: json(gatewayErrorBody({
            message: upstreamError.message,
            code: 'upstream_client_error',
            upstreamCode: upstreamError.code,
            upstreamStatus: err.status,
            provider: descriptor.provider,
            requestedModel: trace.requestedModel ?? '',
            resolvedModel: descriptor.resolvedModel ?? trace.requestedModel ?? '',
            requestId,
            suggestion: suggestionFor(err.status),
          }), err.status),
        };
      }
    }
  }

  if (!upstream || !chosen) {
    const open = lastError instanceof CircuitOpenError;
    const status = open ? 503 : 502;
    const errorCode = open ? 'upstream_unavailable' : 'upstream_unreachable';
    const lastDescriptor = [...candidates].reverse().find((candidate) => candidate.provider === tried.at(-1));
    const upstreamError = lastError instanceof UpstreamHttpError
      ? parseUpstreamBody(lastError.body)
      : { message: errorMessage(lastError) };
    debug('all_upstreams_exhausted', { circuitOpen: open, status, tried, attempts, error: upstreamError.message });
    emit({
      ...trace, provider: tried[tried.length - 1] ?? '', status, ok: false,
      resolvedModel: lastDescriptor?.resolvedModel,
      errorCode, errorMessage: upstreamError.message, attempts, candidatesTried: tried,
      request: capturedRequest,
    });
    return {
      kind: 'response',
      response: json(gatewayErrorBody({
        message: upstreamError.message || 'All upstreams unavailable',
        code: errorCode,
        upstreamCode: upstreamError.code,
        upstreamStatus: lastError instanceof UpstreamHttpError ? lastError.status : undefined,
        provider: lastDescriptor?.provider ?? tried.at(-1) ?? '',
        requestedModel: trace.requestedModel ?? '',
        resolvedModel: lastDescriptor?.resolvedModel ?? trace.requestedModel ?? '',
        requestId,
        suggestion: suggestionFor(lastError instanceof UpstreamHttpError ? lastError.status : status),
      }), status),
    };
  }

  return { kind: 'success', value: { upstream, chosen, tried, attempts } };
}
