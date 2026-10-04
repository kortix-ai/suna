/**
 * The project service surface: what other domains import from projects.
 * The /v1/projects routes are in http/projects.
 */

// Git-proxy public API (consumed by http/git-proxy).
export {
  withProjectGitAuth,
  resolveProjectUpstream,
  authorizeGitProxy,
  RETRYABLE_GIT_AUTH_REASONS,
  type GitProxyAuth,
} from '../git/project-git';

// Session helpers (consumed by channels and provisioning).
export {
  buildSessionSandboxEnvVars,
  createProjectSession,
} from '../sessions/sessions';

export {
  createSession,
  startSession,
  continueSession,
  drainSessionLifecycleQueue,
  resolveProjectAutomationActor,
} from '../sessions/lifecycle';

// Trigger + manifest helpers (consumed by channels / connector / the boot
// sequence in src/app/index.ts).
export {
  drainTriggerExecutionQueue,
  runProjectTriggerSweep,
  resolveGitTriggerActor,
  startProjectTriggerScheduler,
  stopProjectTriggerScheduler,
  schedulerSweepIsStale,
  loadManifestForEdit,
  commitManifest,
} from '../triggers/trigger-runtime';
