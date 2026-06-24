import type { OpenAPIHono } from '@hono/zod-openapi';
import { createGateway } from '@kortix/llm-gateway';
import { Hono } from 'hono';
import { config } from '../config';
import { createInProcessGatewayHooks } from './hooks';
import { createInternalGatewayRoutes } from './internal-routes';

// Single place that wires every LLM-gateway surface onto the API:
//
//   /v1/llm            In-process gateway running the FULL package pipeline
//                      (multi-transport, failover, breakers, budgets, traces).
//                      Serves self-host / dev and is the fallback when no
//                      standalone gateway URL is configured. Same code as the
//                      out-of-process pod — only the hook binding differs
//                      (direct calls here vs HTTP in the standalone service).
//   /internal/gateway  Control-plane RPC the out-of-process gateway pod calls.
//   /v1/llm-gateway/*  Reverse proxy to the standalone gateway (when configured).
export function mountLlmGateway(app: OpenAPIHono): void {
  if (!config.LLM_GATEWAY_ENABLED) {
    app.all('/v1/llm/*', (c) => c.json({ error: 'LLM gateway is disabled' }, 503));
  } else {
    // One gateway instance per process — its circuit breakers are long-lived.
    const gateway = createGateway(createInProcessGatewayHooks(), { captureBodies: true });
    const llm = new Hono();
    llm.get('/health', (c) =>
      c.json({ status: 'ok', service: 'kortix-llm-gateway', mode: 'in-process' }),
    );
    llm.post('/chat/completions', async (c) =>
      gateway.chatCompletions({
        authorization: c.req.header('authorization'),
        rawBody: await c.req.text(),
      }),
    );
    llm.get('/models', (c) => gateway.listModels(c.req.header('authorization')));
    app.route('/v1/llm', llm);
  }

  app.route('/internal/gateway', createInternalGatewayRoutes());

  if (config.LLM_GATEWAY_PROXY_PORT || config.LLM_GATEWAY_PROXY_TARGET) {
    const proxyBase = (
      config.LLM_GATEWAY_PROXY_TARGET || `http://127.0.0.1:${config.LLM_GATEWAY_PROXY_PORT}`
    ).replace(/\/+$/, '');
    app.all('/v1/llm-gateway/*', async (c) => {
      const tail = c.req.path.slice('/v1/llm-gateway'.length) || '/';
      const target = `${proxyBase}${tail}`;
      const init: RequestInit & { duplex?: 'half' } = {
        method: c.req.method,
        headers: c.req.raw.headers,
      };
      if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
        init.body = c.req.raw.body;
        init.duplex = 'half';
      }
      const upstream = await fetch(target, init);
      return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
    });
  }
}
