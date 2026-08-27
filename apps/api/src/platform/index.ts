import { createRoute, z } from '@hono/zod-openapi';
import type { AppEnv } from '../types';
import { makeOpenApiApp, json } from '../openapi';
import { versionRouter } from './routes/version';
import { githubAppSetupRouter } from './routes/github-app';
import { bootTimelineRouter } from './routes/boot-timeline';
import { runtimeProjectionRouter } from './routes/runtime-projection';

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
platformApp.route('/sandbox/version', versionRouter);
// /v1/platform/github-app/{manifest-start,manifest-callback,install-callback,status}
// — the in-app self-host GitHub App setup flow (DB-backed managed App config).
platformApp.route('/github-app', githubAppSetupRouter);
// /v1/platform/boot-timeline — the in-sandbox daemon relays its own boot marks
// here at runtime-ready. Makes in-guest boot latency queryable next to the host
// marks (provider_events, kind 'boot'); see services/boot-timeline-store.ts.
platformApp.route('/boot-timeline', bootTimelineRouter);
// /v1/platform/runtime-projection — the in-sandbox daemon pushes its
// `/kortix/opencode/state` document here so a session open (and a STOPPED
// session) can answer agents/commands/config from Postgres with zero sandbox
// hops; see projects/lib/session-runtime-projection.ts.
platformApp.route('/runtime-projection', runtimeProjectionRouter);

export { platformApp };
