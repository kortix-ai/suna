import {
  DEFAULT_MAX_REQUEST_BYTES,
  InflightBudget,
  createGateway,
  gatewayErrorResponse,
  gatewayOverloadedResponse,
  readAdmittedBody,
  releaseWhenResponseEnds,
  requestTooLargeResponse,
} from '@kortix/llm-gateway';
import { automaticInflightBudgetBytes } from './memory-budget';

// One admission budget protects one standalone process. Work beyond capacity
// receives a typed response before its body is retained.
const defaultInflight = new InflightBudget({
  maxBytes: Number(process.env.GATEWAY_INFLIGHT_BUDGET_BYTES) || automaticInflightBudgetBytes(),
  perRequestMaxBytes: Number(process.env.GATEWAY_MAX_REQUEST_BYTES) || DEFAULT_MAX_REQUEST_BYTES,
});
import { Hono } from 'hono';
import { createApiClient } from './clients/api-client';
import { config } from './config';
import { type TraceSink, createLangfuseSink } from './observability/langfuse';
import { createGatewayLogger } from './observability/logger';

const STARTED_AT = Date.now();
const SERVICE_VERSION = process.env.KORTIX_VERSION ?? 'dev';
const SERVICE_COMMIT = process.env.KORTIX_COMMIT ?? 'unknown';
const TRAFFIC_WINDOW_S = 300;
// Below this volume in the window, a high error rate is statistical noise, not
// an incident worth flagging.
const ERROR_RATE_MIN_VOLUME = 20;
const ERROR_RATE_ALERT = 0.5;

export interface GatewayServer {
  app: Hono;
  traces: TraceSink | null;
}

export function buildServer(options: { inflight?: InflightBudget } = {}): GatewayServer {
  const inflight = options.inflight ?? defaultInflight;
  const api = createApiClient({ baseUrl: config.apiUrl, token: config.apiToken });

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
      // Combined gate: one RPC for auth + billing + budget on the chat hot path
      // (vs three sequential round-trips). authenticate/assertBillingActive/
      // assertBudget remain for the /models path and the interface contract.
      authorize: api.authorize,
      resolveRoute: api.resolveRoute,
      resolveUpstream: api.resolveUpstream,
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

  // Rolling per-second traffic buckets feeding the health endpoint's error-rate
  // signal — bounded to the window (≤300 buckets), pruned on every record.
  const trafficBuckets = new Map<number, { req: number; err: number }>();
  const recordOutcome = (status: number) => {
    const sec = Math.floor(Date.now() / 1000);
    const bucket = trafficBuckets.get(sec) ?? { req: 0, err: 0 };
    bucket.req += 1;
    if (status >= 500) bucket.err += 1;
    trafficBuckets.set(sec, bucket);
    const cutoff = sec - TRAFFIC_WINDOW_S;
    for (const key of trafficBuckets.keys()) if (key < cutoff) trafficBuckets.delete(key);
  };
  const trafficSnapshot = () => {
    const cutoff = Math.floor(Date.now() / 1000) - TRAFFIC_WINDOW_S;
    let requests = 0;
    let errors = 0;
    for (const [sec, bucket] of trafficBuckets) {
      if (sec >= cutoff) {
        requests += bucket.req;
        errors += bucket.err;
      }
    }
    return {
      window_s: TRAFFIC_WINDOW_S,
      requests,
      errors,
      error_rate: requests ? Number((errors / requests).toFixed(4)) : 0,
    };
  };

  const app = new Hono();

  // Shallow liveness: the process is up. The k8s livenessProbe should point here
  // so a dependency outage (which a restart can't fix) doesn't crash-loop the pod.
  // Includes version/commit so a rollout can be confirmed with one cheap probe
  // (no deep dependency checks) — `curl /health/live` shows which build is live.
  app.get('/health/live', (c) =>
    c.json({ ok: true, version: SERVICE_VERSION, commit: SERVICE_COMMIT }),
  );

  // Deep health/readiness, built for an external monitor: an overall status, the
  // specific incidents, dependency checks, and a rolling error rate. Returns HTTP
  // 503 when unhealthy so a bot can alert on the status code alone, then read
  // `incidents`/`checks` for the what.
  app.get('/health', async (c) => {
    const apiCheck = await api.ping();
    const traffic = trafficSnapshot();
    const admission = {
      used_bytes: inflight.inflightBytes,
      capacity_bytes: inflight.capacityBytes,
      utilization: Number(inflight.utilisation.toFixed(4)),
    };
    const errorSpike =
      traffic.requests >= ERROR_RATE_MIN_VOLUME && traffic.error_rate >= ERROR_RATE_ALERT;

    const incidents: string[] = [];
    if (!apiCheck.ok)
      incidents.push(`kortix api unreachable (${apiCheck.error ?? `http ${apiCheck.status}`})`);
    if (errorSpike)
      incidents.push(
        `error rate ${(traffic.error_rate * 100).toFixed(0)}% over ${traffic.window_s}s`,
      );

    const status = !apiCheck.ok ? 'unhealthy' : incidents.length ? 'degraded' : 'healthy';

    return c.json(
      {
        status,
        service: 'kortix-llm-gateway',
        version: SERVICE_VERSION,
        commit: SERVICE_COMMIT,
        uptime_s: Math.floor((Date.now() - STARTED_AT) / 1000),
        timestamp: new Date().toISOString(),
        incidents,
        checks: {
          api: {
            status: apiCheck.ok ? 'up' : 'down',
            latency_ms: apiCheck.latencyMs,
            ...(apiCheck.status ? { http_status: apiCheck.status } : {}),
            ...(apiCheck.error ? { error: apiCheck.error } : {}),
          },
          traces: { langfuse: traces ? 'enabled' : 'disabled' },
          admission,
        },
        traffic,
      },
      status === 'unhealthy' ? 503 : 200,
    );
  });

  const chatCompletions = async (c: {
    req: {
      header: (k: string) => string | undefined;
      text: () => Promise<string>;
      // The standard Request is needed to reserve capacity before reading it.
      // `signal` is read off the same object for the
      // client-disconnect abort below.
      raw: Request;
    };
  }) => {
    const requestId = `req_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    try {
      // Reserve capacity before the body is materialized.
      const body = await readAdmittedBody(c.req.raw, config.maxRequestBytes, inflight);
      if (!body.ok) {
        const status = body.reason === 'too_large' ? 413 : 503;
        if (body.reason === 'overloaded') {
          console.warn('[gateway] admission overloaded', {
            usedBytes: inflight.inflightBytes,
            capacityBytes: inflight.capacityBytes,
            utilization: inflight.utilisation,
          });
        }
        recordOutcome(status);
        return status === 413
          ? requestTooLargeResponse(requestId)
          : gatewayOverloadedResponse(body.retryAfterSeconds ?? 1, requestId);
      }
      try {
        const request = {
          authorization: c.req.header('authorization'),
          rawBody: body.body,
          // `c.req.raw` is Hono's underlying standard Request — its `.signal`
          // fires on client disconnect, so a caller that goes away mid-request
          // stops the upstream fetch/stream instead of running to completion.
          signal: c.req.raw?.signal,
        };
        body.body = '';
        const res = await gateway.chatCompletions(request);
        recordOutcome(res.status);
        return releaseWhenResponseEnds(res, body.release);
      } catch (error) {
        body.release();
        throw error;
      }
    } catch (err) {
      console.error('[gateway] request failed', err);
      recordOutcome(503);
      return gatewayErrorResponse(503, {
        message: 'Gateway unavailable',
        code: 'gateway_error',
        provider: '',
        requestedModel: '',
        resolvedModel: '',
        requestId,
        suggestion: 'Retry the request. If the error continues, switch to another model.',
      });
    }
  };

  // The API reverse proxy exposes `/v1/llm-gateway` as the OpenAI base URL.
  // It strips that prefix before forwarding the request, so OpenAI-compatible
  // clients reach this service at `/chat/completions`.
  app.post('/chat/completions', chatCompletions);
  app.post('/v1/chat/completions', chatCompletions);
  app.post('/v1/llm/chat/completions', chatCompletions);
  app.post('/v1/openai/chat/completions', chatCompletions);

  // Anthropic-Messages-compatible ingress — a client speaking the Anthropic
  // Messages API shape (`{model, system, messages, tools, max_tokens,
  // stream}`) hits the same auth/routing/dispatch/settlement pipeline as
  // `/v1/chat/completions`; `gateway.messages` translates request/response/SSE
  // at the edges only. Mirrors the chat-completions alias namespaces above.
  const messages = async (c: {
    req: {
      header: (k: string) => string | undefined;
      text: () => Promise<string>;
      raw: Request;
    };
  }) => {
    try {
      const body = await readAdmittedBody(c.req.raw, config.maxRequestBytes, inflight);
      if (!body.ok) {
        const status = body.reason === 'too_large' ? 413 : 503;
        recordOutcome(status);
        return status === 413
          ? requestTooLargeResponse()
          : gatewayOverloadedResponse(body.retryAfterSeconds ?? 1);
      }
      try {
        const request = {
          authorization: c.req.header('authorization'),
          rawBody: body.body,
        };
        body.body = '';
        const res = await gateway.messages(request);
        recordOutcome(res.status);
        return releaseWhenResponseEnds(res, body.release);
      } catch (error) {
        body.release();
        throw error;
      }
    } catch (err) {
      console.error('[gateway] messages request failed', err);
      recordOutcome(503);
      return new Response(
        JSON.stringify({
          type: 'error',
          error: { type: 'api_error', message: 'Gateway unavailable' },
        }),
        { status: 503, headers: { 'content-type': 'application/json' } },
      );
    }
  };

  app.post('/messages', messages);
  app.post('/v1/messages', messages);
  app.post('/v1/llm/messages', messages);
  app.post('/v1/openai/messages', messages);

  // `?scope=managed` → managed lineup only (~3KB). Sandboxes call it on every
  // boot to learn the live managed set; see wire.ts for the full rationale.
  const models = (c: {
    req: { header: (k: string) => string | undefined; query: (k: string) => string | undefined };
  }) =>
    gateway.listModels(c.req.header('authorization'), {
      managedOnly: c.req.query('scope') === 'managed',
    });

  app.get('/models', models);
  app.get('/v1/models', models);
  app.get('/v1/llm/models', models);
  app.get('/v1/openai/models', models);

  return { app, traces };
}
