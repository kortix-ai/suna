/**
 * One writer or reader of the release store's managed-skill state at a time.
 *
 * `verifyRelease` reads the overlay's skill names, then walks the release.
 * The runtime-assets pass rewrites the overlay and injects it into the running
 * release. Interleaved, a walk sees an injected skill that the names it read
 * did not include, reports an ADDED file, and the convergence rebuilds the
 * release and respawns OpenCode (DEF-5, 3 of 20 fresh boots, 2026-09-22).
 * Everything that reads or writes that state runs under this lock. In-process
 * only: the daemon is the single writer of `/opt/kortix`.
 */
let releaseStoreQueue: Promise<unknown> = Promise.resolve()

export function withReleaseStoreLock<T>(section: () => Promise<T>): Promise<T> {
  const run = releaseStoreQueue.then(section, section)
  releaseStoreQueue = run.catch(() => undefined)
  return run
}
