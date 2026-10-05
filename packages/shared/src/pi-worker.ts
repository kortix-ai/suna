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

/**
 * The reserved sandbox slug of a session that runs as a pi cell: the pi agent
 * as a Durable Object on celld (apps/pi-worker-js) in a Platinum
 * `runtime: cell` sandbox. Matched before project template resolution, like
 * PI_WORKER_SANDBOX_SLUG. A session lands on it when the project's `pi_cell`
 * feature flag is on (projects/lib/session-create.ts).
 */
export const PI_CELL_SANDBOX_SLUG = 'pi-cell';
