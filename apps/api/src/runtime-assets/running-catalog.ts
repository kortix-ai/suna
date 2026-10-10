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

/**
 * Per-model answers for ids OUTSIDE the managed lineup (`codex/…`, BYOK), which
 * no health report lists. `null` = this box's daemon predates per-model
 * converge, so asking it again is pointless until the TTL lapses.
 */
const confirmedModels = new Map<string, { models: Set<string> | null; at: number }>();

export function noteModelConfirmation(sessionId: string, model: string | null): void {
  const entry = confirmedModels.get(sessionId);
  const fresh = entry && Date.now() - entry.at <= RUNNING_CATALOG_TTL_MS;
  if (!fresh && confirmedModels.size >= MAX_TRACKED_SESSIONS) {
    const oldest = confirmedModels.keys().next();
    if (!oldest.done) confirmedModels.delete(oldest.value);
  }
  const models = model === null ? null : new Set([...(fresh ? (entry.models ?? []) : []), model]);
  confirmedModels.set(sessionId, { models, at: fresh ? entry.at : Date.now() });
}

export function modelConfirmation(sessionId: string, model: string): 'present' | 'legacy' | undefined {
  const entry = confirmedModels.get(sessionId);
  if (!entry || Date.now() - entry.at > RUNNING_CATALOG_TTL_MS) return undefined;
  if (entry.models === null) return 'legacy';
  return entry.models.has(model) ? 'present' : undefined;
}

export function __clearRunningCatalogForTests(): void {
  runningCatalog.clear();
  confirmedModels.clear();
}
