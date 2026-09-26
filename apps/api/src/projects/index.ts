/**
 * Project CRUD.
 *
 * Project is the new first-class source-of-truth object: one account-owned Git
 * repo plus the Kortix metadata needed to render and launch sessions later.
 * The old sandbox/instance tables remain as legacy compute state.
 *
 * ─── Structural note ─────────────────────────────────────────────────────────
 * The wired Hono app and the shared helpers live in ./lib/*. The route
 * registrations live in ./routes/*, one file per domain (projects, secrets,
 * connections, triggers, channels, sessions, change requests, ...). This file is
 * a thin barrel: it imports the route modules for their side-effect registration
 * and re-exports the public surface that external importers use.
 */

// Route registrations run as import side-effects. The order here IS the route
// registration order, and Hono dispatches in registration order — preserve it.
// ./routes/projects registers the global `/*` auth middleware first (its first
// statement), then the remaining route groups follow.
import './routes/projects';
import './routes/trigger-webhooks';
import './routes/project-git';
import './routes/github-installations';
import './routes/github-repositories';
import './routes/git-backend';
import './routes/project-from-repository';
import './routes/manifest-validation';
import './routes/sandboxes';
import './routes/sandbox-templates';
import './routes/project-credentials';
import './routes/secrets';
import './routes/secret-delivery';
import './routes/provider-oauth';
import './routes/repository-replacement';
import './routes/secret-broker';
import './routes/secret-relay';
import './routes/setup-links';
import './routes/connections';
import './routes/connection-actions';
import './routes/triggers';
import './routes/channel-slack';
import './routes/channel-teams';
import './routes/channel-email';
import './routes/turn-stream';
import './routes/models';
import './routes/turn-questions';
import './routes/oauth2-connectors';
import './routes/project-detail';
import './routes/project-files';
import './routes/project-settings';
import './routes/project-access';
import './routes/access-requests';
import './routes/project-invites';
import './routes/group-grants';
import './routes/warm-sessions';
import './routes/project-sessions';
import './routes/session-environment';
import './routes/session-transcripts';
import './routes/session-attachments';
import './routes/session-open-bundle';
import './routes/session-stream';
import './routes/project-audit';
import './routes/approvals';
import './routes/resource-grants';
import './routes/session-scope';
import './routes/provider-secret-pools';
import './routes/session-config';
import '../config-releases/routes';
import './routes/public-shares';
import './routes/session-runtime';
import './routes/session-prompts';
import './routes/change-requests';
import './routes/prompt-attachments';
import './routes/change-request-actions';
import './routes/marketplace-install-session';
import './routes/review-items';
import './routes/agent-scope';
import './routes/agent-config';
import './routes/gateway';
import './routes/channel-bindings';
import './routes/monitors';
import '../apps/routes';

// The wired Hono app instances (all routes registered above via side-effect).
export { projectsApp, projectWebhooksApp } from './lib/app';

// Git-proxy public API (consumed by ../git-proxy).
export {
  withProjectGitAuth,
  resolveProjectUpstream,
  authorizeGitProxy,
  RETRYABLE_GIT_AUTH_REASONS,
  type GitProxyAuth,
} from './lib/git';

// Session helpers (consumed by channels and provisioning).
export {
  buildSessionSandboxEnvVars,
  createProjectSession,
} from './lib/sessions';

export {
  createSession,
  startSession,
  continueSession,
  drainSessionLifecycleQueue,
  resolveProjectAutomationActor,
} from './session-lifecycle';

// Trigger + manifest helpers (consumed by channels / connector / the boot
// sequence in src/index.ts).
export {
  drainTriggerExecutionQueue,
  runProjectTriggerSweep,
  resolveGitTriggerActor,
  startProjectTriggerScheduler,
  stopProjectTriggerScheduler,
  getTriggerSchedulerHealth,
  schedulerSweepIsStale,
  loadManifestForEdit,
  commitManifest,
} from './lib/triggers';
