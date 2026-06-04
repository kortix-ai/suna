/**
 * Project CRUD.
 *
 * Project is the new first-class source-of-truth object: one account-owned Git
 * repo plus the Kortix metadata needed to render and launch sessions later.
 * The old sandbox/instance tables remain as legacy compute state.
 *
 * ─── Structural note ─────────────────────────────────────────────────────────
 * This module was split for size: the wired Hono app + all helpers now live in
 * ./lib/*, and the 104 route registrations live in ./routes/r1..r9 (grouped by
 * original registration order). This file is a thin barrel: it imports the route
 * modules for their side-effect registration (IN THE ORIGINAL ROUTE ORDER — Hono
 * matches by registration order) and re-exports the same public surface the
 * pre-split file exported, so every external importer keeps working unchanged.
 */

// Route registrations run as import side-effects. The order here IS the route
// registration order — preserve it. r1 registers the global `/*` auth
// middleware first (its first statement), then routes; r4 registers the
// `/:projectId/apps` middleware before the apps routes (both within r4).
import './routes/r1';
import './routes/r2';
import './routes/r3';
import './routes/r4';
import './routes/r5';
import './routes/r6';
import './routes/r7';
import './routes/r8';
import './routes/r9';

// The wired Hono app instances (all routes registered above via side-effect).
export { projectsApp, projectWebhooksApp } from './lib/app';

// Git-proxy public API (consumed by ../git-proxy).
export {
  withProjectGitAuth,
  resolveProjectUpstream,
  authorizeGitProxy,
  type GitProxyAuth,
} from './lib/git';

// Session helpers (consumed by warm-pool / channels).
export {
  buildSessionSandboxEnvVars,
  createProjectSession,
} from './lib/sessions';

// Trigger + manifest helpers (consumed by channels / executor / the boot
// sequence in src/index.ts).
export {
  runProjectTriggerSweep,
  resolveGitTriggerActor,
  startProjectTriggerScheduler,
  stopProjectTriggerScheduler,
  loadManifestForEdit,
  commitManifest,
} from './lib/triggers';
