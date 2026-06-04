import { createRoute, z } from '@hono/zod-openapi';
import { config } from '../config';
import { apiKeyAuth } from '../middleware/auth';
import { makeOpenApiApp, json } from '../openapi';
import { webSearch } from './routes/search-web';
import { imageSearch } from './routes/search-image';
import { llm } from './routes/llm';
import { sessionLlm } from './routes/session-llm';
import { proxy } from './routes/proxy';
import { anthropic } from './routes/anthropic';

const router = makeOpenApiApp();

// Health checks (no auth)
router.openapi(
  createRoute({
    method: 'get',
    path: '/health',
    tags: ['router'],
    summary: 'Router service health check',
    responses: {
      200: json(
        z.object({
          status: z.string(),
          service: z.string(),
          timestamp: z.string(),
          billing_enabled: z.boolean(),
        }),
        'Router health status',
      ),
    },
  }),
  (c) => {
    return c.json({
      status: 'ok',
      service: 'kortix-router',
      timestamp: new Date().toISOString(),
      billing_enabled: config.KORTIX_BILLING_INTERNAL_ENABLED,
    });
  },
);

// Search routes (apiKeyAuth)
router.use('/web-search/*', apiKeyAuth);
router.use('/image-search/*', apiKeyAuth);
router.route('/web-search', webSearch);
router.route('/image-search', imageSearch);

// LLM routes (apiKeyAuth)
router.route('/llm', sessionLlm);
router.use('/chat/*', apiKeyAuth);
router.use('/messages', apiKeyAuth);
router.use('/models', apiKeyAuth);
router.use('/models/*', apiKeyAuth);
router.route('/', llm);
router.route('/', anthropic);

// Proxy routes (auth handled internally — dual mode)
router.route('/', proxy);

export { router };
