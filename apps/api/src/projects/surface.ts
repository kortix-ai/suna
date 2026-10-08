/**
 * The public service surface of `projects/`: the names other domains import.
 *
 * A module outside `projects/` imports from `projects` (index.ts) or from this
 * file, never from a file deeper in the folder (lint: kortix-api/projects-surface).
 * This file holds no routes, so a service can import it without pulling in the
 * route registrations that index.ts loads.
 */

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

// The shutdown hand-back of lifecycle claims (consumed by bootstrap.ts).
export { handBackClaims } from './session-lifecycle/claim-handover';

// Trigger + manifest helpers (consumed by channels / connector / the boot
// sequence in src/index.ts).
export {
  drainTriggerExecutionQueue,
  runProjectTriggerSweep,
  startProjectTriggerScheduler,
  stopProjectTriggerScheduler,
  schedulerSweepIsStale,
  loadManifestForEdit,
  commitManifest,
} from './lib/triggers';
