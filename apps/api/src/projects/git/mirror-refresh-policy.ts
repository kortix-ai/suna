/**
 * WAIT FOR THE FETCH, OR SERVE WHAT WE HAVE AND FETCH BEHIND IT?
 *
 * Every project mirror read goes through `refreshMirror`, which re-fetches when
 * the local copy is older than `KORTIX_GIT_REFRESH_INTERVAL_MS` (60 s). The
 * caller waits for that fetch.
 *
 * MEASURED on dev 2026-09-09, timing the three steps inside
 * `readManifestFromRepo` on the session-create path:
 *
 *   {"mirror":  3, "lsTree":0, "show":3}   warm
 *   {"mirror":  4, "lsTree":0, "show":3}   warm
 *   {"mirror": 12, "lsTree":0, "show":4}   warm
 *   {"mirror":462, "lsTree":0, "show":3}   <- the TTL expired
 *
 * `ls-tree` and `show` are free; a warm mirror is single-digit ms; and the
 * whole cost is that one blocking fetch. It landed on `loadProjectAgents`,
 * which was 625 ms of a 675 ms `POST /v1/projects/:id/sessions` — 92% of
 * creating a session, spent asking a git remote whether the manifest had
 * changed. Sessions arrive minutes apart, so nearly every one pays it.
 *
 * THE ARGUMENT FOR NOT WAITING. The TTL is already a staleness contract: for 60
 * seconds after a fetch, every reader is served a copy that may be out of date,
 * deliberately. Blocking a caller to close the last moments of that window buys
 * a guarantee the window itself does not make. Serving the warm copy and
 * refreshing behind it extends the worst case by roughly one read, inside a
 * bound the design already accepted.
 *
 * WHAT STILL BLOCKS, because there is no honest alternative:
 *   - no mirror on disk yet — there is nothing to serve;
 *   - `force`, which is what a caller passes when it must see a specific commit
 *     (a push webhook, a deploy resolving a SHA).
 */

export type MirrorRefreshPlan =
  /** Nothing to do: the copy on disk is inside the TTL. */
  | 'serve_warm'
  /** Serve the copy on disk and fetch behind it. */
  | 'serve_warm_refresh_behind'
  /** The caller waits: nothing to serve, or it asked for certainty. */
  | 'block_and_fetch';

export interface MirrorRefreshInput {
  /** Is there a usable mirror on disk right now? */
  present: boolean;
  /** Age of the local copy in ms. */
  ageMs: number;
  /** The TTL (`KORTIX_GIT_REFRESH_INTERVAL_MS`). */
  ttlMs: number;
  /** The caller asked to see the remote's current state. */
  force: boolean;
  /** Operator switch; off means the old always-block behaviour. */
  backgroundEnabled: boolean;
}

/**
 * Pure, so every branch is asserted rather than raced against a git remote.
 */
export function planMirrorRefresh(input: MirrorRefreshInput): MirrorRefreshPlan {
  if (!input.present) return 'block_and_fetch';
  if (input.force) return 'block_and_fetch';
  const stale = !Number.isFinite(input.ageMs) || input.ageMs >= input.ttlMs;
  if (!stale) return 'serve_warm';
  return input.backgroundEnabled ? 'serve_warm_refresh_behind' : 'block_and_fetch';
}
