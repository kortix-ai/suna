/**
 * The reserved sandbox slug of a session that runs as a pi cell: the pi agent
 * as a Durable Object on celld (apps/pi-worker-js) in a Platinum
 * `runtime: cell` sandbox. Like META_SANDBOX_SLUG it is matched BEFORE project
 * template resolution (platform/services/session-sandbox.ts), so it is not a
 * user-definable template name. A session lands on it when the project's
 * `pi_cell` feature flag is on (projects/lib/session-create.ts).
 */
export const PI_CELL_SANDBOX_SLUG = 'pi-cell';
