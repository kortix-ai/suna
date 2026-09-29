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
 *
 * WHAT THIS NO LONGER DOES, AND WHY
 * ---------------------------------
 * Until 2026-09-27 the trip SHUT THE DAEMON DOWN with exit 0, on the premise
 * that "a dead session token never recovers". That premise is false twice
 * over, and the combination is unrecoverable:
 *
 *   - the token dies because the CONTROL PLANE's row is wrong, not because
 *     anything on this box is. A session credential is refused whenever its
 *     sandbox row is not `provisioning`/`active`, so a wrong `stopped` row
 *     kills a healthy box's credential, and the platform can put the row
 *     right and rotate the credential (`rotateKortixToken`);
 *   - exit 0 is read by the entrypoint as an intentional stop, and Platinum's
 *     pt-init launches the chain once and never again — the VM survives with
 *     nothing serving on it.
 *
 * Measured on dev 2026-09-27: row parked at 20:56:46, breaker tripped at
 * 20:57:55, `[entrypoint] agent exited 0 after 900s; exiting`. Eleven minutes
 * later the provider still reported `running`, our row reported `active`,
 * every ingress port answered 502, and the control plane accepted a prompt
 * against it (202, then a turn that ended `abandoned`). A dead token is a
 * control-plane error, and a box must never convert one into a terminal state
 * of its own (runtime-convergence Rule 2).
 *
 * So the breaker now only REPORTS. It stops the log spam (one line per trip,
 * not one per 401) and exposes the state, and it clears itself the moment the
 * control plane answers anything else — which is what a rotated credential
 * looks like from here. The state a consuming call site reads is
 * `sessionTokenPresumedDead()`: `reconcileRuntimeAssets` uses it to skip the
 * manifest fetch, so a box that stays up after its row is parked stops adding
 * one `warn` 401 per 60 s tick to the API log. It never converts the dead token
 * into a terminal state of the box. The volume problem it was built for is
 * closed at its source: a box whose row and VM disagree is reconciled within
 * one sweep (apps/api/src/projects/reaping/row-vm-divergence.ts).
 */
const SESSION_TOKEN_DEAD_PATTERN =
  // The API has TWO terminal refusals for a session credential, and a living
  // box can meet either one:
  //   - `Session token is not active` — the sandbox row left
  //     `provisioning`/`active`, so `validateAccountToken` withdrew the lease
  //     (`SESSION_LEASE_REFUSAL`).
  //   - `PAT not found or revoked` — the token ROW is gone or revoked, which is
  //     what session delete (`revokeSessionConnectorTokens`) and account
  //     offboarding (`revokeAllAccountTokensForUser`) write.
  // Both are permanent for this credential: no retry schedule can bring either
  // back. Recognising only the first left the second hammering the API forever
  // (KRTX-446). The daemon holds exactly one session credential, so neither
  // string can mean a human PAT here.
  /session token is not active|pat not found or revoked/i

/** Consecutive dead-token signals before the breaker reports the credential dead. */
export const SESSION_TOKEN_DEAD_TRIP_THRESHOLD = 5

let consecutiveDeadTokenSignals = 0
let tripped = false

/**
 * Has the API told this box, repeatedly and without contradiction, that its
 * credential is dead? A consuming call site skips a request that cannot succeed;
 * it never acts on the credential beyond that (no restart, no shutdown).
 */
export function sessionTokenPresumedDead(): boolean {
  return tripped
}

/**
 * Report one control-plane HTTP response. Called from every daemon->API call
 * site that can receive a terminal session-credential 401 — `Session token is
 * not active` (session row parked) or `PAT not found or revoked` (token row
 * revoked) — never trust a single occurrence (a genuinely transient 401 during
 * token rotation reads identically for one call), but never let it keep
 * retrying past the threshold either.
 */
export function noteControlPlaneResponse(status: number, bodyText: string | null | undefined): void {
  const isDeadToken = status === 401 && SESSION_TOKEN_DEAD_PATTERN.test(bodyText ?? '')
  if (!isDeadToken) {
    consecutiveDeadTokenSignals = 0
    // Any other answer from the API is proof the credential works again — a
    // rotation landed, or the sandbox row it hangs off was put right.
    if (tripped) {
      tripped = false
      logger.warn('[session-token-health] control plane answering again; credential recovered')
    }
    return
  }
  consecutiveDeadTokenSignals += 1
  if (consecutiveDeadTokenSignals < SESSION_TOKEN_DEAD_TRIP_THRESHOLD || tripped) return
  tripped = true
  // Loud, once. NEVER a shutdown: see the header. The daemon keeps serving and
  // keeps asking, so a rotated credential is picked up on the next call.
  logger.error('[session-token-health] control plane says this session credential is dead', {
    consecutiveDeadTokenSignals,
  })
}

export function resetSessionTokenHealthForTests(): void {
  consecutiveDeadTokenSignals = 0
  tripped = false
}
