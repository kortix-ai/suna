import { CircuitOpenError, UpstreamHttpError } from '../errors';
import { CircuitBreaker } from '../resilience';
import { callUpstream, type FetchImpl } from '../http';
import type { GatewayConfig, UpstreamDescriptor } from '../domain';
import type { TraceEmitter, TraceFields } from './trace';

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

  for (const descriptor of candidates) {
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
