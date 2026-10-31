/**
 * One writer or reader of the release store's managed-skill state at a time.
 *
 * `verifyRelease` and the release seal read the overlay's skill names, then
 * walk the release. The runtime-assets pass rewrites the overlay. Interleaved,
 * a walk sees a managed skill that the names it read did not include, reports
 * an ADDED file, and the convergence rebuilds the release (DEF-5, 3 of 20
 * fresh boots, 2026-09-22, when the pass also injected the overlay into the
 * running release).
 * Everything that reads or writes that state runs under this lock. In-process
 * only: the daemon is the single writer of `/opt/kortix`.
 */
let releaseStoreQueue: Promise<unknown> = Promise.resolve()

export function withReleaseStoreLock<T>(section: () => Promise<T>): Promise<T> {
  const run = releaseStoreQueue.then(section, section)
  releaseStoreQueue = run.catch(() => undefined)
  return run
}
