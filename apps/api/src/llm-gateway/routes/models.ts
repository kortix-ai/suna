import { createRoute, z } from '@hono/zod-openapi';
import type { LlmGatewayConfig } from '../types';
import type { AppEnv } from '../../types';
import { listOpenRouterModels } from '../services/openrouter-client';
import { makeOpenApiApp, json, errors } from '../../openapi';

export function createModelsRoute(config: LlmGatewayConfig) {
  const app = makeOpenApiApp<AppEnv>();

  app.openapi(
    createRoute({
      method: 'get',
      path: '/models',
      tags: ['llm'],
      summary: 'List available models (proxied from OpenRouter)',
      responses: {
        200: json(
          // Opaque OpenRouter models payload — forwarded verbatim.
          z.object({ data: z.array(z.any()).optional() }).passthrough(),
          'OpenRouter models payload (forwarded verbatim)',
        ),
        ...errors(500, 502),
      },
    }),
    async (c) => {
      const baseUrl = config.baseUrl ?? 'https://openrouter.ai/api/v1';
      const upstream = await listOpenRouterModels({
        baseUrl,
        apiKey: config.openrouterApiKey,
        appName: config.appName,
        appReferer: config.appReferer,
      });

      if (!upstream.ok) {
        const text = await upstream.text().catch(() => '');
        // Opaque upstream proxy: status is dynamic (any OpenRouter error code),
        // so the response is returned as a raw Response to preserve the exact
        // status/body instead of constraining it to the enumerated codes.
        return c.json(
          { error: text || `OpenRouter models endpoint error ${upstream.status}` },
          upstream.status as any,
        ) as any;
      }

      const json = await upstream.json();
      return c.json(json);
    },
  );

  return app;
}
