import { CircuitOpenError, UpstreamHttpError } from '../errors';
import { CircuitBreaker } from '../resilience';
import { callUpstream, type FetchImpl } from '../http';
import type { GatewayConfig, UpstreamDescriptor } from '../domain';
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

export interface FailoverContext {
  candidates: UpstreamDescriptor[];
  payload: Record<string, unknown>;
  config: GatewayConfig;
  fetchImpl?: FetchImpl;
  breakerFor: (provider: string) => CircuitBreaker;
  emit: TraceEmitter;
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
  const { candidates, payload, config, fetchImpl, breakerFor, emit, trace, capturedRequest } = ctx;
  const tried: string[] = [];
  let attempts = 0;
  let upstream: Response | null = null;
  let chosen: UpstreamDescriptor | null = null;
  let lastError: unknown;

  for (let i = 0; i < candidates.length; i += 1) {
    const descriptor = candidates[i];
    const hasFallback = i < candidates.length - 1;
    tried.push(descriptor.provider);
    attempts += 1;
    try {
      upstream = await callUpstream(payload, descriptor, {
        retry: { ...config.retry, onRetry: (info) => { attempts += 1; config.retry?.onRetry?.(info); } },
        binding: { provider: descriptor.provider, breaker: breakerFor(descriptor.provider) },
        fetchImpl,
      });
      chosen = descriptor;
      break;
    } catch (err) {
      lastError = err;
      if (err instanceof UpstreamHttpError && err.status >= 400 && err.status < 500) {
        // A rate-limit / quota / billing error (429/402/403) on a candidate that
        // has a fallback behind it — e.g. a user's BYOK key out of quota, with a
        // managed model queued next — falls over instead of failing the turn.
        // (429 was already retried on this candidate by callUpstream, so reaching
        // here means it's persistent, not a transient blip.) Other 4xx — bad
        // request, auth, model-not-found — are the caller's to fix: return as-is.
        if (LIMIT_STATUSES.has(err.status) && hasFallback) {
          continue;
        }
        emit({
          ...trace, resolvedModel: descriptor.resolvedModel, provider: descriptor.provider,
          billingMode: descriptor.billingMode, status: err.status, ok: false,
          errorCode: 'upstream_client_error', errorMessage: err.body, attempts, candidatesTried: tried,
          request: capturedRequest,
        });
        return { kind: 'response', response: json({ error: err.body || `Upstream error ${err.status}` }, err.status) };
      }
    }
  }

  if (!upstream || !chosen) {
    const open = lastError instanceof CircuitOpenError;
    const status = open ? 503 : 502;
    const errorCode = open ? 'upstream_unavailable' : 'upstream_unreachable';
    emit({
      ...trace, provider: tried[tried.length - 1] ?? '', status, ok: false,
      errorCode, errorMessage: errorMessage(lastError), attempts, candidatesTried: tried,
      request: capturedRequest,
    });
    return { kind: 'response', response: json({ error: 'All upstreams unavailable', code: errorCode }, status) };
  }

  return { kind: 'success', value: { upstream, chosen, tried, attempts } };
}
