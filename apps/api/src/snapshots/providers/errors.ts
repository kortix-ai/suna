/**
 * Typed provider-side image errors shared by every adapter and its callers.
 */

/**
 * The provider refuses to delete an image because running sandboxes still use
 * it. Platinum answers `409 template_in_use` for this (its DELETE
 * /v1/templates/:id refuses while any sandbox pins the rootfs). Daytona deletes
 * a snapshot under live sandboxes, so today only Platinum raises it.
 *
 * This is an expected state, not an outage. A caller maps it to a 409 the user
 * can act on (stop the sessions, then rebuild), never to a generic 5xx.
 */
export class SnapshotInUseError extends Error {
  constructor(
    readonly snapshotName: string,
    /** Sandboxes the provider reported as still using the image. */
    readonly inUse: number,
  ) {
    super(`image ${snapshotName} is still used by ${inUse} running sandbox(es)`);
    this.name = 'SnapshotInUseError';
  }
}
