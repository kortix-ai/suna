/**
 * What the API last SAW a box running for RUNTIME ASSETS — the daemon, the CLI,
 * the managed-skill overlay and OpenCode — per session.
 *
 * The sibling of `config-releases/running-release.ts`, and a LEAF for the same
 * reason: it imports nothing. `projects/lib/turn-start-convergence.ts` writes and
 * reads it, and putting it in that module would close an import cycle the
 * moment anything in the runtime-assets graph wanted to read it back.
 *
 * It is an OPTIMISATION, never an authority. A miss costs one scheduled pass —
 * which is fire-and-forget and off the send path by construction — and it can
 * never make a box look current when it is not, because the only writer is the
 * box's own report of the digests it has on disk.
 *
 * WHY EVERY ENTRY CARRIES A FINGERPRINT. A verdict is only meaningful against
 * the manifest it was computed from. During a rolling deploy two API versions
 * serve two manifests, and a `behind` verdict computed against one of them would
 * otherwise keep process A scheduling a pass the box refuses (its epoch guard
 * will not go backwards) for the length of the rollout. A read whose stored
 * fingerprint does not equal the caller's is a MISS, not a hit.
 */

/**
 * How long the API trusts its last observation of a box's runtime assets.
 *
 * Longer than it sounds, and deliberately so: nothing here gates a turn. The
 * cost of a stale `current` is that a box stays one turn behind on a binary,
 * which is the state that exists today anyway. The cost of a too-short TTL is a
 * scheduled pass on a box that is already fine. Same value as
 * `config-releases/running-release.ts` so the two age together.
 */
export const RUNNING_ASSETS_TTL_MS = 10 * 60_000;
const MAX_TRACKED_SESSIONS = 20_000;

/** `current` and `behind` only. "Could not tell" is never remembered. */
export type RunningAssetsMemoVerdict = 'current' | 'behind';

interface Entry {
  fingerprint: string;
  verdict: RunningAssetsMemoVerdict;
  at: number;
}

const runningAssets = new Map<string, Entry>();

/**
 * The API was told what a box has on disk. Called from the SAME health read the
 * config gate already makes, so this costs the turn path zero network calls.
 */
export function noteRunningAssets(
  sessionId: string,
  fingerprint: string,
  verdict: RunningAssetsMemoVerdict,
): void {
  if (runningAssets.size >= MAX_TRACKED_SESSIONS) {
    // A Map preserves insertion order, so this evicts the oldest entry.
    const oldest = runningAssets.keys().next();
    if (!oldest.done) runningAssets.delete(oldest.value);
  }
  runningAssets.delete(sessionId);
  runningAssets.set(sessionId, { fingerprint, verdict, at: Date.now() });
}

/**
 * What the API last saw, or `undefined` when it does not know — which includes
 * "knows, but about a different manifest".
 */
export function lastKnownAssetVerdict(
  sessionId: string,
  fingerprint: string,
): RunningAssetsMemoVerdict | undefined {
  const entry = runningAssets.get(sessionId);
  if (!entry) return undefined;
  if (Date.now() - entry.at > RUNNING_ASSETS_TTL_MS) {
    runningAssets.delete(sessionId);
    return undefined;
  }
  // A verdict about another manifest is not evidence about this one.
  if (entry.fingerprint !== fingerprint) return undefined;
  return entry.verdict;
}

/** A box we just told to converge is no longer known to be behind or current. */
export function forgetRunningAssets(sessionId: string): void {
  runningAssets.delete(sessionId);
}

export function __clearRunningAssetsForTests(): void {
  runningAssets.clear();
  pinnedReportedAt.clear();
}

/**
 * Has this box's rollback latch been reported recently?
 *
 * `pinned: true` means a daemon update crash-looped, the supervisor rolled it
 * back and latched updates OFF. That box will not self-heal and needs a human —
 * which is worth one loud line, not one per turn. Rate-limited per session, in
 * the same leaf as the memo so the two age together and neither needs a timer.
 */
export const PINNED_ALARM_INTERVAL_MS = 30 * 60_000;
const pinnedReportedAt = new Map<string, number>();

export function shouldReportPinned(sessionId: string): boolean {
  const now = Date.now();
  const last = pinnedReportedAt.get(sessionId);
  if (last !== undefined && now - last < PINNED_ALARM_INTERVAL_MS) return false;
  if (pinnedReportedAt.size >= MAX_TRACKED_SESSIONS) {
    const oldest = pinnedReportedAt.keys().next();
    if (!oldest.done) pinnedReportedAt.delete(oldest.value);
  }
  pinnedReportedAt.delete(sessionId);
  pinnedReportedAt.set(sessionId, now);
  return true;
}
