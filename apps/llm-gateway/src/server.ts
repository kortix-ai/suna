import { createGateway } from '@kortix/llm-gateway';
import { pickAutoModel } from '@kortix/shared/llm-catalog';
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

export function buildServer(): GatewayServer {
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
    {
      retry: config.retry,
      breaker: config.breaker,
      captureBodies: config.captureBodies,
      maxCapturedBodyBytes: config.maxCapturedBodyBytes,
      // Tier-aware: a free account's `auto` resolves to a free model, not a paid
      // one it has no upstream for. The principal (with freeModelsOnly, set by
      // the API at auth) arrives over the authorize RPC and is passed through here.
      autoRouter: (model, body, principal) =>
        pickAutoModel(model, body, { free: !!principal.freeModelsOnly }),
    },
    { logger },
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
    const breakers = gateway.breakerHealth();
    const openBreakers = breakers.filter((b) => b.state === 'open');
    const traffic = trafficSnapshot();
    const errorSpike =
      traffic.requests >= ERROR_RATE_MIN_VOLUME && traffic.error_rate >= ERROR_RATE_ALERT;

    const incidents: string[] = [];
    if (!apiCheck.ok)
      incidents.push(`kortix api unreachable (${apiCheck.error ?? `http ${apiCheck.status}`})`);
    if (openBreakers.length)
      incidents.push(`upstream circuit open: ${openBreakers.map((b) => b.provider).join(', ')}`);
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
          upstreams: {
            status: openBreakers.length ? 'degraded' : 'ok',
            tracked: breakers.length,
            open: openBreakers.map((b) => b.provider),
            breakers,
          },
          traces: { langfuse: traces ? 'enabled' : 'disabled' },
        },
        traffic,
      },
      status === 'unhealthy' ? 503 : 200,
    );
  });

  const chatCompletions = async (c: {
    req: { header: (k: string) => string | undefined; text: () => Promise<string> };
  }) => {
    try {
      const res = await gateway.chatCompletions({
        authorization: c.req.header('authorization'),
        rawBody: await c.req.text(),
      });
      recordOutcome(res.status);
      return res;
    } catch (err) {
      console.error('[gateway] request failed', err);
      recordOutcome(503);
      return new Response(JSON.stringify({ error: 'Gateway unavailable', code: 'gateway_error' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });
    }
  };

  app.post('/v1/chat/completions', chatCompletions);
  app.post('/v1/llm/chat/completions', chatCompletions);
  app.post('/v1/openai/chat/completions', chatCompletions);

  const models = (c: { req: { header: (k: string) => string | undefined } }) =>
    gateway.listModels(c.req.header('authorization'));

  app.get('/v1/models', models);
  app.get('/v1/llm/models', models);
  app.get('/v1/openai/models', models);

  return { app, traces };
}
