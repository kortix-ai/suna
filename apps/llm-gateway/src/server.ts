import { Hono } from 'hono';
import { createGateway } from '@kortix/llm-gateway';
import { config } from './config';
import { createApiClient } from './clients/api-client';
import { createLangfuseSink, type TraceSink } from './observability/langfuse';

export interface GatewayServer {
  app: Hono;
  traces: TraceSink | null;
}

export function buildServer(): GatewayServer {
  const api = createApiClient({ baseUrl: config.apiUrl, token: config.apiToken });

  const traces =
    config.langfuse.publicKey && config.langfuse.secretKey
      ? createLangfuseSink({
          publicKey: config.langfuse.publicKey,
          secretKey: config.langfuse.secretKey,
          baseUrl: config.langfuse.baseUrl,
        })
      : null;

  if (!traces) console.warn('[gateway] LANGFUSE_PUBLIC_KEY/LANGFUSE_SECRET_KEY unset — Langfuse disabled (request logs still persist via the API)');

  const gateway = createGateway(
    {
      authenticate: api.authenticate,
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
    },
  );

  const app = new Hono();

  app.get('/health', (c) => c.json({ ok: true }));

  const chatCompletions = async (c: { req: { header: (k: string) => string | undefined; text: () => Promise<string> } }) => {
    try {
      return await gateway.chatCompletions({
        authorization: c.req.header('authorization'),
        rawBody: await c.req.text(),
      });
    } catch (err) {
      console.error('[gateway] request failed', err);
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
