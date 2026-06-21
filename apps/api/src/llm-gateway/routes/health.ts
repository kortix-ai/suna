import { createRoute, z } from '@hono/zod-openapi';
import type { LlmGatewayConfig } from '../types';
import type { AppEnv } from '../../types';
import { makeOpenApiApp, json } from '../../openapi';

export function createHealthRoute(config: LlmGatewayConfig) {
  const app = makeOpenApiApp<AppEnv>();

  app.openapi(
    createRoute({
      method: 'get',
      path: '/health',
      tags: ['llm'],
      summary: 'LLM gateway health and configuration status',
      responses: {
        200: json(
          z.object({
            ok: z.boolean(),
            enabled: z.boolean(),
            baseUrl: z.string(),
            markup: z.number(),
            keyConfigured: z.boolean(),
          }),
          'Gateway health',
        ),
      },
    }),
    (c) =>
      c.json({
        ok: true,
        enabled: config.enabled,
        baseUrl: config.baseUrl ?? 'https://openrouter.ai/api/v1',
        markup: config.markup ?? 1,
        keyConfigured: !!config.openrouterApiKey,
      }),
  );

  return app;
}
