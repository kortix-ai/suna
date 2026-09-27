/**
 * What the API last SAW a box report about its MANAGED MODEL CATALOG — the
 * sibling of `running-assets.ts` (binaries) and `config-releases/
 * running-release.ts` (config releases), and a LEAF for the identical reason
 * both of those are: it imports nothing, so `projects/lib/
 * turn-start-convergence.ts` and `projects/lib/model-catalog-turn-start.ts`
 * can both read it without an import cycle.
 *
 * An OPTIMISATION, never an authority. A miss costs one extra
 * `POST /kortix/catalog/converge` on a turn that would have needed one
 * anyway — the daemon re-checks before doing anything, so a redundant call is
 * wasted latency, not a wrong answer. It can never make the API think a
 * model is present when the box has never confirmed it: the only writer is
 * the box's own health report (`noteAssetsFromHealth` in
 * `turn-start-convergence.ts`).
 */

/** How long the API trusts its last observation of a box's managed catalog.
 *  Same value as `running-assets.ts`'s TTL so the two age together. */
export const RUNNING_CATALOG_TTL_MS = 10 * 60_000;
const MAX_TRACKED_SESSIONS = 20_000;

export interface RunningCatalogEntry {
  /** Managed ids the box last confirmed. Null = UNCONFIRMED, never "empty". */
  ids: string[] | null;
  fallbackReason: string | null;
}

interface Entry extends RunningCatalogEntry {
  at: number;
}

const runningCatalog = new Map<string, Entry>();

/** The API was told what a box's managed catalog looks like. Called from the
 *  SAME health read the config/asset gates already make. */
export function noteRunningCatalog(
  sessionId: string,
  ids: string[] | null,
  fallbackReason: string | null,
): void {
  if (runningCatalog.size >= MAX_TRACKED_SESSIONS) {
    // A Map preserves insertion order, so this evicts the oldest entry.
    const oldest = runningCatalog.keys().next();
    if (!oldest.done) runningCatalog.delete(oldest.value);
  }
  runningCatalog.delete(sessionId);
  runningCatalog.set(sessionId, { ids, fallbackReason, at: Date.now() });
}

/** What the API last saw, or `undefined` when it does not know (never
 *  observed, or the observation aged out). */
export function lastKnownManagedCatalog(sessionId: string): RunningCatalogEntry | undefined {
  const entry = runningCatalog.get(sessionId);
  if (!entry) return undefined;
  if (Date.now() - entry.at > RUNNING_CATALOG_TTL_MS) {
    runningCatalog.delete(sessionId);
    return undefined;
  }
  return { ids: entry.ids, fallbackReason: entry.fallbackReason };
}

/** A box we just told to converge is no longer known to have (or lack) a
 *  model — the next turn re-measures instead of re-sending. */
export function forgetRunningCatalog(sessionId: string): void {
  runningCatalog.delete(sessionId);
}

export function __clearRunningCatalogForTests(): void {
  runningCatalog.clear();
}
