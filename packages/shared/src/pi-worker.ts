/**
 * The reserved sandbox slug that boots a session on the compiled pi worker
 * runtime instead of the OpenCode stack. Like META_SANDBOX_SLUG it is matched
 * BEFORE project template resolution (platform/services/session-sandbox.ts),
 * so it is not a user-definable template name.
 *
 * A session lands on this slug only when BOTH gates hold: the project's
 * `pi_worker` feature flag is on AND its manifest declares `runtime: pi`
 * (projects/lib/sessions.ts). Neither alone changes how anything boots.
 */
export const PI_WORKER_SANDBOX_SLUG = 'pi-worker';
