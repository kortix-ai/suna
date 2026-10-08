import { createRoute, z } from '@hono/zod-openapi';
import { makeOpenApiApp, json } from '../openapi';
import { proxy, registerProxyRoutes } from './routes/proxy';

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
    });
  },
);

// Proxy routes (auth handled internally — dual mode)
registerProxyRoutes();
router.route('/', proxy);

export { router };
