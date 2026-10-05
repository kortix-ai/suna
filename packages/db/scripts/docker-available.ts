/**
 * One probe for every disposable-PostgreSQL contract in this directory.
 *
 * Two reasons this is a module instead of a copied expression:
 *
 *  1. `Bun.spawnSync` THROWS `ENOENT` when the binary is absent, and these
 *     probes run at module scope. Bun reports a throw during module evaluation
 *     as "Unhandled error between tests": it raises the failure count, names no
 *     test, and exits the package non-zero. A machine without Docker used to
 *     turn `pnpm --filter @kortix/db test` red with nine unnamed failures.
 *  2. Nine copies meant nine `docker version` child processes per run.
 */
export const dockerAvailable = ((): boolean => {
  try {
    return (
      Bun.spawnSync(['docker', 'version'], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0
    );
  } catch {
    return false;
  }
})();
