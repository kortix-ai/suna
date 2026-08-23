/**
 * Root OpenCode sessions this daemon has seen a turn START on.
 *
 * The reconnect reconcile (`reconcileFinishedTrackedTurns`, main.ts) can only
 * ask about roots it knows a turn ran on. `reconcileFinishedFirstTurn` covers
 * the boot-pinned root; this registry adds every other root a turn was observed
 * on, from three observers:
 *
 *   - `proxied_prompt`   — the control plane delivered a prompt THROUGH this
 *                          daemon's reverse proxy (`POST /session/:id/prompt_async`
 *                          | `/message` | `/command` | `/shell`). This is the
 *                          only observer that sees a turn which starts AND ends
 *                          while the /event subscription is down.
 *   - `status_frame`     — a `busy`/`retry` status frame named the root.
 *   - `turn_begin_relay` — the box-initiated turn relay announced it.
 *
 * Why it exists (live 2026-08-23, session eddd499a, first prompt "yo?!"): a
 * pre-prompt env push replaced OpenCode (verified swap: new process on the
 * other port, old one killed). The /event loop was subscribed to the OLD
 * process; it re-subscribes to the new one only after the drop (~100ms +
 * connect). The prompt reached the new process first, OpenCode answered in
 * ~5s, and its one `session.idle` was emitted into that gap — there is no
 * replay. No `end` relayed; the ledger turn stayed `active`; the web showed
 * "Gathering thoughts" for 80+s. The pinned-root reconcile could not help:
 * the turn did not run on the pinned root.
 *
 * Bounded and per-process, like the relay dedup sets in main.ts.
 */
export type TrackedTurnSource = 'proxied_prompt' | 'status_frame' | 'turn_begin_relay'

interface TrackedRootTurn {
  firstSeenAt: number
  lastSeenAt: number
  source: TrackedTurnSource
}

/** Plenty for one sandbox (a session has one root; Task children are filtered
 *  out by the relay's root check), small enough that the per-tick reconcile
 *  stays a handful of local reads. */
export const MAX_TRACKED_ROOT_TURN_SESSIONS = 64

const tracked = new Map<string, TrackedRootTurn>()

export function trackRootTurnSession(
  opencodeSessionId: string,
  source: TrackedTurnSource,
  now: number = Date.now(),
): void {
  const id = opencodeSessionId.trim()
  if (!id) return
  const existing = tracked.get(id)
  if (existing) {
    existing.lastSeenAt = now
    return
  }
  tracked.set(id, { firstSeenAt: now, lastSeenAt: now, source })
  while (tracked.size > MAX_TRACKED_ROOT_TURN_SESSIONS) {
    const oldest = tracked.keys().next().value
    if (oldest === undefined) break
    tracked.delete(oldest)
  }
}

/** Tracked root ids, oldest first. */
export function trackedRootTurnSessions(): string[] {
  return [...tracked.keys()]
}

/** Test-only. */
export function __resetTrackedRootTurnSessions(): void {
  tracked.clear()
}

// OpenCode's turn-starting routes. `message` is the blocking prompt,
// `prompt_async` the non-blocking one the control plane uses, `command` a
// slash command, `shell` a shell turn. Session ids are `ses_` + base62-ish;
// anything outside the id alphabet is not a session path.
const TURN_START_PATH = /^\/session\/([A-Za-z0-9_-]{1,128})\/(?:prompt_async|message|command|shell)$/

/** The OpenCode session id a proxied request starts a turn on, else null. */
export function proxiedPromptSessionId(method: string, pathname: string): string | null {
  if (method.toUpperCase() !== 'POST') return null
  const match = TURN_START_PATH.exec(pathname)
  return match?.[1] ?? null
}
