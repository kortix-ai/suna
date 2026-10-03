/** Host-written and image-baked platform state paths.
 *
 *  The image stages artifacts under /opt/kortix for production. The unit suites
 *  must be hermetic — identical on a laptop, a CI runner and a Kortix worker
 *  sandbox (apps/api/scripts/test.env states the contract) — and a worker
 *  sandbox IS such a box, so the artifacts exist there and turn "absent on a
 *  laptop" fixtures into "present" ones: the baked LLM catalog makes
 *  model-convergence conclude "unchanged", the baked scaffold makes the clone
 *  tests materialize through the scaffold fast path, and /etc/pt-env makes
 *  health believe the session wants a repo. The hermetic suite entries override
 *  these to paths that cannot exist, so a worker box runs the suite exactly as
 *  a laptop that has none. Production reads the literals: the env overrides are
 *  never set outside the suite entries.
 */

/** The image-baked LLM model catalog. */
export function bakedLlmCatalogPath(): string {
  return process.env.KORTIX_BAKED_LLM_CATALOG_FILE || '/opt/kortix/llm-catalog.json'
}

/** The image-baked git scaffold the seed builder and the cold boot clone from. */
export function scaffoldRepoPath(): string {
  return process.env.KORTIX_SCAFFOLD_REPO_PATH || '/opt/kortix/scaffold.git'
}

/** The host-written session env file the box reads before its own process env
 *  exists (a warm-snapshot restore writes it pre-boot). */
export function hostSessionEnvPath(): string {
  return process.env.KORTIX_SESSION_ENV_FILE || '/etc/pt-env'
}
