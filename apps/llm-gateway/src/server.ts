import {
  DEFAULT_BODY_AMPLIFICATION,
  DEFAULT_MAX_REQUEST_BYTES,
  InflightBudget,
  createGateway,
} from '@kortix/llm-gateway';
import { automaticInflightBudgetBytes } from './memory-budget';

// One admission budget protects one standalone process. Work beyond capacity
// receives a typed response before its body is retained.
const inflightCapacityBytes =
  Number(process.env.GATEWAY_INFLIGHT_BUDGET_BYTES) || automaticInflightBudgetBytes();
// A per-request cap larger than the budget can ever admit is a lie: such a
// request is refused 413 `too_large` ("never retry") when the honest answer is
// that this process is too small for it. Clamp to what the budget can hold.
export const perRequestCapBytes = Math.min(
  Number(process.env.GATEWAY_MAX_REQUEST_BYTES) || DEFAULT_MAX_REQUEST_BYTES,
  Math.floor(
    inflightCapacityBytes /
      (Number(process.env.GATEWAY_BODY_AMPLIFICATION) || DEFAULT_BODY_AMPLIFICATION),
  ),
);
// How much resident memory one wire byte really costs while it is in flight.
// This is the safety margin that decides how many big requests run at once, so
// it is deliberately conservative and measured, not guessed: a single isolated
// 27 MiB request peaks at ~2.3x (memory-envelope.test.ts), but under real
// concurrency the transient copies of different requests overlap and GC lags
// behind, so the honest number is higher. At 3x, 60 concurrent 27 MiB uploads
// OOM-killed a 2 GiB container (measured 2026-08-24); the same load survives
// at 6x with peak RSS well under the limit.
const bodyAmplification =
  Number(process.env.GATEWAY_BODY_AMPLIFICATION) || DEFAULT_BODY_AMPLIFICATION;
const defaultInflight = new InflightBudget({
  maxBytes: inflightCapacityBytes,
  perRequestMaxBytes: perRequestCapBytes,
  amplification: bodyAmplification,
});
import { Hono } from 'hono';
import { createApiClient } from './clients/api-client';
import { config } from './config';
import { type TraceSink, createLangfuseSink } from './observability/langfuse';
import { createGatewayLogger } from './observability/logger';
import { registerHealth } from './health';
import { trackInflight } from './inflight';
import { registerRoutes } from './routes';
import { createTraffic } from './traffic';

export interface GatewayServer {
  app: Hono;
  traces: TraceSink | null;
  /** Requests still being served, including streams still relaying. */
  inflightRequests: () => number;
}

// Cloudflare replaces an ORIGIN 502 or 504 with its own HTML "Bad gateway"
// page (Enterprise-only "Origin Error Page Pass-thru" turns that off). Every
// public gateway host sits behind a proxied Cloudflare hostname, so a JSON
// `502 upstream_error` reached OpenCode as an HTML page and surfaced as
// "AI_APICallError: Bad Gateway" with no code, no request id and no
// suggestion (dev 2026-08-24; SampleCo 2026-08-22). 503 passes through
// unchanged. The original status is kept on a header and in the body so
// nothing is lost — only the transport-level rewrite is avoided.
const CLOUDFLARE_REWRITTEN_STATUSES = new Set([502, 504]);
export const UPSTREAM_STATUS_HEADER = 'x-kortix-upstream-status';

export async function cloudflareSafe(res: Response): Promise<Response> {
  if (!CLOUDFLARE_REWRITTEN_STATUSES.has(res.status)) return res;
  const headers = new Headers(res.headers);
  headers.set(UPSTREAM_STATUS_HEADER, String(res.status));
  if (!headers.has('retry-after')) headers.set('retry-after', '5');
  const contentType = headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const text = await res.text();
    try {
      const body = JSON.parse(text) as Record<string, unknown>;
      body.upstream_status = res.status;
      return new Response(JSON.stringify(body), { status: 503, headers });
    } catch {
      return new Response(text, { status: 503, headers });
    }
  }
  return new Response(res.body, { status: 503, headers });
}

// Anthropic SDKs, and Claude Code with ANTHROPIC_API_KEY, send the key as
// `x-api-key`. The Anthropic-shaped route accepts it when no Authorization
// header is present.
export function messagesAuthorization(
  authorization: string | undefined,
  apiKey: string | undefined,
): string | undefined {
  if (authorization) return authorization;
  const key = apiKey?.trim();
  return key ? `Bearer ${key}` : undefined;
}

export function buildServer(options: { inflight?: InflightBudget } = {}): GatewayServer {
  const inflight = options.inflight ?? defaultInflight;
  const api = createApiClient({ baseUrl: config.apiUrl, token: config.apiToken, edgeKey: config.internalEdgeKey });

  const logger = createGatewayLogger();

  const traces =
    config.langfuse.publicKey && config.langfuse.secretKey
      ? createLangfuseSink({
          publicKey: config.langfuse.publicKey,
          secretKey: config.langfuse.secretKey,
          baseUrl: config.langfuse.baseUrl,
        })
      : null;

  if (!traces)
    console.warn(
      '[gateway] LANGFUSE_PUBLIC_KEY/LANGFUSE_SECRET_KEY unset — Langfuse disabled (request logs still persist via the API)',
    );

  const gateway = createGateway(
    {
      authenticate: api.authenticate,
      // Combined authentication + budget gate. Billing runs after model resolution.
      authorize: api.authorize,
      resolveRoute: api.resolveRoute,
      resolveUpstream: api.resolveUpstream,
      notePoolRateLimit: api.notePoolRateLimit,
      refreshCredential: api.refreshCredential,
      assertBillingActive: api.assertBillingActive,
      assertBudget: api.assertBudget,
      recordUsage: api.recordUsage,
      listModels: api.listModels,
      recordTrace: async (trace) => {
        const sinks: Promise<unknown>[] = [api.recordTrace(trace)];
        if (traces) sinks.push(traces.record(trace));
        await Promise.allSettled(sinks);
      },
    },
    { logger, imageWindow: config.imageWindow },
  );
  const app = new Hono();
  const { recordOutcome, trafficSnapshot } = createTraffic();
  const inflightRequests = trackInflight(app);
  registerHealth(app, api, inflight, traces, trafficSnapshot);
  registerRoutes(app, gateway, inflight, recordOutcome);
  return { app, traces, inflightRequests };
}
