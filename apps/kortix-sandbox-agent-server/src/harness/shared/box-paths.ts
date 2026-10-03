/**
 * The box's well-known deployment paths, each overridable so the TEST suite can
 * present a developer box.
 *
 * A runtime image carries the real baked assets and the host-written platform
 * env file; the suite's contracts assume they are absent (`loadGatewayCatalog`
 * must fall through to the minimal set, `sessionWantsRepo` must see no
 * platform env). `src/__tests__/preload-isolated-home.ts` points every one of
 * these at a fresh temp path; on a developer box or CI the variables are unset
 * and the defaults apply. Read once at module load, which the preload's
 * environment is set before.
 */

/** Where the snapshot builder bakes the full org model catalog (see
 *  dockerfile-layer.ts `COPY ${catalogPath} /opt/kortix/llm-catalog.json`).
 *  Present on every modern image; the fast, always-available fallback so a slow
 *  or down gateway never collapses the picker to the minimal set. */
export const BAKED_LLM_CATALOG_PATH =
  (process.env.KORTIX_BAKED_LLM_CATALOG ?? '').trim() || '/opt/kortix/llm-catalog.json'

/** The host-written env file carrying the live session's variables
 *  (`KORTIX_BRANCH_NAME`, `KORTIX_PROJECT_AUTO_CLONE`, …). Absent on a
 *  developer box; every reader treats that as "not a session sandbox". */
export const PT_ENV_PATH = (process.env.KORTIX_PT_ENV_FILE ?? '').trim() || '/etc/pt-env'
