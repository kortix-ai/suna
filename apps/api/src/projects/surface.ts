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

// Project access, the route app and the secret envelope (consumed by ../apps/kinds/convex).
export { assertProjectCapability, loadProjectForUser } from './lib/access';
export { projectsApp } from './lib/app';
export { decryptProjectSecret, encryptProjectSecret } from './secrets/envelope';
export { currentInstanceId } from './instance-scope';

// What account erasure deletes outside the database (consumed by
// ../billing/services/account-deletion): each project's session files and its
// Kortix-managed repo.
export { sessionAttachmentStore } from './lib/session-attachments';
export { deleteManagedProjectRepo } from './lib/project-deletion';
export { isAlreadyNotRunning } from './reaping/policy';

// Nested `projects.metadata` writes (consumed by ../feature-flags/write).
export { metadataClearSubtreeKey, metadataMergeSubtree } from './lib/metadata-merge';

// Whether any app-event adapter is configured (consumed by ../feature-flags/registry).

// App-event subscriptions (consumed by connector sync/connect and account
// deletion). Loaded on first call: their import chain reaches back into
// connectors/, which imports this file, and an eager re-export closes that cycle
// with a half-initialized module.
const eventSubscriptions = () => import('./trigger-events/subscriptions');
export const reconcileEventSubscriptions: typeof import('./trigger-events/subscriptions').reconcileEventSubscriptions =
  async (...args) => (await eventSubscriptions()).reconcileEventSubscriptions(...args);
export const reconcileEventSubscriptionsFromCatalog: typeof import('./trigger-events/subscriptions').reconcileEventSubscriptionsFromCatalog =
  async (...args) => (await eventSubscriptions()).reconcileEventSubscriptionsFromCatalog(...args);
export const releaseProjectEventSubscriptions: typeof import('./trigger-events/subscriptions').releaseProjectEventSubscriptions =
  async (...args) => (await eventSubscriptions()).releaseProjectEventSubscriptions(...args);

// Drive sync's last push before a synced box loses a writable folder (consumed by drives/service.ts).
export { flushDriveSyncBeforeStop } from './reaping/stop-box';

// The transcript mirror's rewind marker (consumed by ../sandbox-proxy).
export { setTranscriptRewindMarker } from './lib/session-transcript-mirror';
