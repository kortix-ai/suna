import { createRoute, z } from '@hono/zod-openapi';
import type { AppEnv } from '../types';
import { makeOpenApiApp, json } from '../openapi';
import { versionRouter } from './routes/version';
import { apiKeysRouter } from './routes/api-keys';

// Platform sub-app. The legacy /v1/platform/sandbox/* lifecycle surface
// (one-per-account sandbox lifecycle, members, invites, pool admin, backup
// routes, etc.) has been removed. The new project-session sandbox lifecycle
// lives under /v1/projects/:id/sessions/:sid/sandbox.
//
// Kept as a mount point so /v1/platform is reserved if we want to layer
// admin-only platform routes here later.
const platformApp = makeOpenApiApp<AppEnv>();

platformApp.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['platform'],
    summary: 'Platform sub-app info',
    responses: {
      200: json(z.object({ ok: z.boolean(), message: z.string() }), 'Platform mount-point info'),
    },
  }),
  (c) => c.json({ ok: true, message: 'platform' }),
);
platformApp.route('/api-keys', apiKeysRouter);
platformApp.route('/sandbox/version', versionRouter);

export { platformApp };
