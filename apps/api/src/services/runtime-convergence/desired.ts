/**
 * The one DESIRED runtime document (Rule 1, the runtime-convergence contract (PR #7785)).
 *
 * Composes, never re-derives:
 *   - `release_id`      — `services/config-releases/desired.ts` (`resolveDesiredRelease`)
 *   - `catalog_fingerprint` — the served managed lineup (./catalog-fingerprint.ts)
 *   - `daemon_build`, `cli_sha256`, `managed_skills_hash` — `services/runtime-assets/manifest.ts`
 *
 * This module owns NONE of those computations. It exists so every reader of
 * "what should this box be running" — the admission gate, `GET /config`'s
 * `runtime` block — reads one shape assembled in one place, instead of each
 * caller composing the three sources itself and one day disagreeing about it.
 */

export interface DesiredRuntimeDocument {
  release_id: string | null;
  catalog_fingerprint: string | null;
  daemon_build: number;
  cli_sha256: string | null;
  managed_skills_hash: string | null;
}

/** The subset of `RuntimeAssetsManifest` this document needs. */
export interface DesiredRuntimeManifest {
  build: number;
  cli_sha256: string | null;
  managed_skills_hash: string | null;
}

export interface DesiredRuntimeDeps {
  /** `runtimeAssetsManifest` (services/runtime-assets/manifest.ts), injected so a test
   *  never pays the ~200 MB binary hash. */
  manifest: () => Promise<DesiredRuntimeManifest>;
  /** `managedLineupFingerprint` (./catalog-fingerprint.ts). */
  catalogFingerprint: () => string;
}

async function defaultDeps(): Promise<DesiredRuntimeDeps> {
  const [{ runtimeAssetsManifest }, { managedLineupFingerprint }] = await Promise.all([
    import('../runtime-assets/manifest'),
    import('./catalog-fingerprint'),
  ]);
  return {
    manifest: runtimeAssetsManifest,
    catalogFingerprint: managedLineupFingerprint,
  };
}

/**
 * `input.releaseId` is the caller's own resolved
 * `resolveDesiredRelease(...).descriptor.release_id` — this function does not
 * resolve it itself, so it never disagrees with `GET /config`'s existing
 * release resolution about what "desired" means for THIS session (project,
 * base ref, agent, repository access).
 */
export async function computeDesiredRuntime(
  input: { releaseId: string | null },
  deps?: DesiredRuntimeDeps,
): Promise<DesiredRuntimeDocument> {
  const resolved = deps ?? (await defaultDeps());
  const manifest = await resolved.manifest();
  return {
    release_id: input.releaseId,
    catalog_fingerprint: resolved.catalogFingerprint(),
    daemon_build: manifest.build,
    cli_sha256: manifest.cli_sha256,
    managed_skills_hash: manifest.managed_skills_hash,
  };
}
