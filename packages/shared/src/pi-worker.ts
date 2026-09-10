/**
 * The reserved sandbox slug that boots a session on the compiled pi worker
 * runtime instead of the OpenCode stack. Like META_SANDBOX_SLUG it is matched
 * BEFORE project template resolution (platform/services/session-sandbox.ts),
 * so it is not a user-definable template name.
 *
 * A session lands on this slug when its pinned manifest declares
 * `kortix_version: 3` (projects/lib/sessions.ts). No feature flag is required.
 */
export const PI_WORKER_SANDBOX_SLUG = 'pi-worker';

/**
 * Provider resources for the minimal Pi harness box.
 *
 * Keep image creation and compute metering on this single value. Treating the
 * reserved slug as a project template falls back to the full environment size
 * and overstates every Pi worker before its separate environment is metered.
 */
export const PI_WORKER_SANDBOX_RESOURCES = {
  cpu: 1,
  memoryGb: 2,
  diskGb: 8,
} as const;
