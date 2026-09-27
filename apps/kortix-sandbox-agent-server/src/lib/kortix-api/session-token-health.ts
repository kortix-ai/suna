import { logger } from '../log/logger'

/**
 * Circuit breaker for a session whose control-plane token is dead.
 *
 * The API's stop path can leave a VM running for its full idle timeout after
 * the session closes — see `PlatinumProvider.stop()`'s confirm-before-return
 * fix for the other half of this incident. Independently of that: even a VM
 * that is legitimately still up for some OTHER reason must not hammer the API
 * once the API has told it, repeatedly, that its token is dead. PROD 76h
 * window: 404,982 `401 Session token is not active` rejections across 95
 * projects — mostly `POST turn-stream`, also `audit/events` and
 * `runtime-assets/manifest` — one box posting for a full 12h after its lease
 * closed. Every call site retries a transient failure on its own schedule
 * (`opencode-audit-relay.ts`'s exponential backoff, `claimInitialTurnFromApi`'s
 * 3-attempt ladder, …) because most 401/5xx responses ARE transient. A dead
 * session token never recovers — no retry schedule, however patient, is the
 * right answer — so this is a SEPARATE signal, orthogonal to each call site's
 * own retry/backoff, that watches for the one error the API can never take
 * back and stops the process once it is unambiguous.
 *
 * A single module-level counter, not one per call site: `turn-stream`,
 * `audit/events`, and `runtime-assets/manifest` all fail for the SAME reason
 * at the SAME moment once the token dies, so counting them together reaches
 * the trip threshold in one round of calls instead of waiting on whichever
 * call site is slowest to retry.
 */
const SESSION_TOKEN_DEAD_PATTERN = /session token is not active/i

/** Consecutive dead-token signals required before the daemon shuts itself down. */
export const SESSION_TOKEN_DEAD_TRIP_THRESHOLD = 5

let consecutiveDeadTokenSignals = 0
let tripped = false
let onTripped: (() => void) | null = null

/** Wired once at boot to the daemon's own graceful shutdown. */
export function configureSessionTokenHealth(handler: () => void): void {
  onTripped = handler
}

/**
 * Report one control-plane HTTP response. Called from every daemon->API call
 * site that can receive the "Session token is not active" 401 — never trust
 * a single occurrence (a genuinely transient 401 during token rotation reads
 * identically for one call), but never let it keep retrying past the
 * threshold either.
 */
export function noteControlPlaneResponse(status: number, bodyText: string | null | undefined): void {
  const isDeadToken = status === 401 && SESSION_TOKEN_DEAD_PATTERN.test(bodyText ?? '')
  if (!isDeadToken) {
    consecutiveDeadTokenSignals = 0
    return
  }
  consecutiveDeadTokenSignals += 1
  if (consecutiveDeadTokenSignals < SESSION_TOKEN_DEAD_TRIP_THRESHOLD || tripped) return
  tripped = true
  logger.warn('[session-token-health] session token reported dead repeatedly; shutting down', {
    consecutiveDeadTokenSignals,
  })
  onTripped?.()
}

export function resetSessionTokenHealthForTests(): void {
  consecutiveDeadTokenSignals = 0
  tripped = false
  onTripped = null
}
