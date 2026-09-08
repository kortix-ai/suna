/**
 * IS THIS SANDBOX A CELL? — answered from the row, not from a provider call.
 *
 * It decides whether the control plane may pin a session's root by construction
 * (`opencode-root-pin.ts`) or must discover it by listing `GET /session`. On a
 * SHARED cell host that discovery is unsound: the request carries no session, so
 * it reaches the worker's default cell and every later session adopts the first
 * one's root.
 *
 * THE OBVIOUS SIGNAL IS NOT ALWAYS THERE, which is what made the first attempt
 * at this fail silently. `pi_worker_boot` is set in the metadata a COLD create
 * passes, but a session that adopts an existing host takes the pooled-claim
 * path, and that path REPLACES the metadata with its own
 * `{provisionedBy, daytonaSandboxId, snapshot, pooled}`. So exactly the sessions
 * that need this — the adopters, the ones sharing a box — are the ones whose
 * row does not say `pi_worker_boot`.
 *
 * Measured on dev 2026-09-08, an adopted session's row:
 *
 *   runtime: null  ->  cellPin: null  ->  discovery  ->  it inherited
 *   3ab0bd9d-f5ab-400f-a85b-0037e0fee4ea, the first session's root.
 *
 * What that row DOES carry is the artifact it booted from — `sandboxSlug` and
 * `runtimeProfile` of `pi-worker` — which survives the pooled-claim rewrite
 * because it describes the image rather than the attempt. So every signal is
 * consulted, and any one of them is enough.
 */

/** The pi worker only ever runs as a cell, so its slug IS the runtime here. */
const PI_WORKER_SLUG = 'pi-worker';

/**
 * `'cell'` when this sandbox is one, else null (meaning "discover", the answer
 * given before this existed).
 *
 * Pure, so each signal is asserted rather than reproduced by provisioning a
 * session two different ways.
 */
export function cellRuntimeFromSandboxMetadata(metadata: unknown): 'cell' | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const meta = metadata as Record<string, unknown>;
  if (String(meta['kortix.runtime'] ?? '').toLowerCase() === 'cell') return 'cell';
  if (meta.pi_worker_boot === true || meta.pi_worker_boot === 'true') return 'cell';
  const artifact = meta.runtimeArtifact;
  if (artifact && typeof artifact === 'object' && !Array.isArray(artifact)) {
    const a = artifact as Record<string, unknown>;
    if (a.sandboxSlug === PI_WORKER_SLUG || a.runtimeProfile === PI_WORKER_SLUG) return 'cell';
  }
  return null;
}
