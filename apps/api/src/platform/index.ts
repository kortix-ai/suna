import { Hono } from 'hono';
import { versionRouter } from './routes/version';

// Platform sub-app. The legacy /v1/platform/sandbox/* lifecycle surface
// (one-per-account sandbox lifecycle, members, invites, pool admin, backup
// routes, etc.) has been removed. The new project-session sandbox lifecycle
// lives under /v1/projects/:id/sessions/:sid/sandbox.
//
// Kept as a mount point so /v1/platform is reserved if we want to layer
// admin-only platform routes here later.
const platformApp = new Hono();

platformApp.get('/', (c) => c.json({ ok: true, message: 'platform' }));
platformApp.route('/sandbox/version', versionRouter);

export { platformApp };
