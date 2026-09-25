/**
 * What the API last SAW a box running, per session.
 *
 * A leaf module on purpose: `config-releases/quarantine.ts` writes it and
 * `projects/lib/turn-start-convergence.ts` reads it, and putting it in either
 * of those closes an import cycle through `config-releases/desired.ts` — which
 * bun resolves as `Cannot access 'dbConfigReleaseLedger' before initialization`
 * at module load, in every test file that touches the graph. It imports
 * nothing.
 *
 * It is an OPTIMISATION, never an authority. A miss costs one convergence
 * attempt; it can never make a box look current when it is not, because the
 * only writer is a daemon's own report of what it serves.
 */

/** How long the API trusts its last observation of what a box runs. */
export const RUNNING_TTL_MS = 10 * 60_000;
const MAX_TRACKED_SESSIONS = 20_000;

const runningReleases = new Map<string, { releaseId: string | null; at: number }>();

/**
 * The API was told what a box runs. Called from `recordDaemonConfigReport`,
 * the single place a daemon's own report reaches the API — a health read, a
 * reload, or a convergence answer.
 */
export function noteRunningRelease(sessionId: string, releaseId: string | null): void {
  if (runningReleases.size >= MAX_TRACKED_SESSIONS) {
    // A Map preserves insertion order, so this evicts the oldest entry.
    const oldest = runningReleases.keys().next();
    if (!oldest.done) runningReleases.delete(oldest.value);
  }
  runningReleases.delete(sessionId);
  runningReleases.set(sessionId, { releaseId, at: Date.now() });
}

/** What the API last saw this box running, or `undefined` when it does not know. */
export function lastKnownRunningRelease(sessionId: string): string | null | undefined {
  const entry = runningReleases.get(sessionId);
  if (!entry) return undefined;
  if (Date.now() - entry.at > RUNNING_TTL_MS) {
    runningReleases.delete(sessionId);
    return undefined;
  }
  return entry.releaseId;
}

export function __clearRunningReleasesForTests(): void {
  runningReleases.clear();
}
