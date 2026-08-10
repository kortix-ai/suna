import { Hono } from 'hono';

import type { AppEnv } from '../types';
import { workspaceResponseCompatibility } from './compat';
import { workspaceRoutesApp } from './lib/app';

/**
 * Workspace CRUD.
 *
 * Workspace is the first-class source-of-truth object: one account-owned Git
 * repository plus the Kortix metadata needed to render and launch sessions.
 * The old sandbox and project database identifiers remain compatibility state.
 *
 * ─── Structural note ─────────────────────────────────────────────────────────
 * This module was split for size: the wired Hono app + all helpers now live in
 * ./lib/*, and the 104 route registrations live in ./routes/r1..r9 (grouped by
 * original registration order). This file is a thin barrel: it imports the route
 * modules for their side-effect registration (IN THE ORIGINAL ROUTE ORDER — Hono
 * matches by registration order) and re-exports the same public surface the
 * pre-split file exported.
 */

// Route registrations run as import side-effects. The order here IS the route
// registration order — preserve it. r1 registers the global `/*` auth
// middleware first (its first statement), then the remaining route groups.
import './routes/r1';
import './routes/github-repositories';
import './routes/r2';
import './routes/r3';
import './routes/secret-broker';
import './routes/setup-links';
import './routes/r4';
import './routes/oauth2-connectors';
import './routes/r5';
import './routes/r6';
import './routes/r7';
import './routes/public-shares';
import './routes/r8';
import './routes/r9';
import './routes/r10';
import './routes/r11';
import './routes/agent-scope';
import './routes/agent-config';
import './routes/gateway';
import './routes/channel-bindings';
import '../apps/routes';
import { registerSunaMigrationRoutes } from './suna-migration/suna-migration-routes';

// Register dynamic account-migration routes before the public wrappers copy
// this registry. Hono's route() call snapshots existing routes.
registerSunaMigrationRoutes(workspaceRoutesApp);

/** Canonical public router. Database-shaped JSON is mapped to Workspace keys. */
export const workspacesApp = new Hono<AppEnv>();
workspacesApp.use('*', workspaceResponseCompatibility);
workspacesApp.route('/', workspaceRoutesApp);

// The webhook router remains a separate mount because webhook auth differs.
export { workspaceWebhooksApp } from './lib/app';

// Git-proxy public API (consumed by ../git-proxy).
export {
  withWorkspaceGitAuth,
  resolveWorkspaceUpstream,
  authorizeGitProxy,
  type GitProxyAuth,
} from './lib/git';

// Session helpers (consumed by channels and provisioning).
export {
  buildSessionSandboxEnvVars,
  createWorkspaceSession,
} from './lib/sessions';

export {
  createSession,
  startSession,
  continueSession,
  drainSessionLifecycleQueue,
  resolveWorkspaceAutomationActor,
} from './session-lifecycle';

// Trigger + manifest helpers (consumed by channels / connector / the boot
// sequence in src/index.ts).
export {
  drainTriggerExecutionQueue,
  runWorkspaceTriggerSweep,
  resolveGitTriggerActor,
  startWorkspaceTriggerScheduler,
  stopWorkspaceTriggerScheduler,
  getTriggerSchedulerHealth,
  schedulerSweepIsStale,
  loadManifestForEdit,
  commitManifest,
} from './lib/triggers';
