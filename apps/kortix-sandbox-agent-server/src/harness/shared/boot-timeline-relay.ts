import { logger } from '@/lib/log/logger'
import type { BootMark, BootTimelineRelayBody } from '@kortix/api-contract/runtime-relay'
import { sandboxRelayContext } from '@/lib/kortix-api/relay-context'
import { noteControlPlaneResponse } from '@/lib/kortix-api/session-token-health'

/**
 * Relays the in-guest boot timeline to the control plane, once, when a
 * session becomes runtime-ready.
 *
 * WHY: `GET /kortix/health` already exposes `bootState.timeline` (see
 * routes/health.ts's `boot_timeline` field), but nothing on the server ever
 * stores it — so the 11-15s of in-guest boot latency (repo-materialized,
 * opencode-session-created, ...) is unattributable after the fact, unlike the
 * HOST side which IS persisted (kortix.provider_events.marks, written by
 * apps/api/src/platform/services/provider-events.ts's recordProviderEvent).
 * This module closes that gap by POSTing the same timeline server-side.
 *
 * INTEGRATION: the connector should call `relayBootTimelineToApi(bootState.timeline)`
 * from main.ts exactly once per boot, right after `runtimeReady` first becomes
 * true — i.e. from the same place that today computes readiness for
 * routes/health.ts (mirrors relayRuntimeSession, which fires at the
 * analogous "session is usable" point for the bootstrap pin). Do not call it
 * more than once per boot; do not call it from the warm-seed capture path
 * (a seed has no session yet — `KORTIX_SESSION_ID` is unset there and the
 * relay below is a no-op anyway, but the extra call is still needless work).
 *
 * Fire-and-forget, non-blocking, and bounded by a timeout — never awaited by
 * the caller and never throws, so a slow or unreachable control plane can
 * never add latency to (or fail) boot. Mirrors relayRuntimeSession's auth:
 * same env vars, same token-fallback order, same "missing config -> silent
 * no-op" behavior (this daemon runs in local/self-host contexts where the API
 * URL or credential may simply not be set).
 */
/**
 * Idempotent by construction rather than by convention. `startSessionRuntime` has
 * two runtime-ready exits (initial-session and plain-readiness) and is also
 * re-entered by the warm-seed adoption paths, so "call this exactly once" is a
 * rule call sites would eventually break. Enforcing it here means the worst a
 * duplicate call can do is nothing.
 */
let relayed = false

export function relayBootTimelineToApi(timeline: BootMark[]): void {
  if (relayed) return
  relayed = true
  void doRelay(timeline)
}

/** Test-only: reset the once-guard between cases. */
export function __resetBootTimelineRelayForTests(): void {
  relayed = false
}

async function doRelay(timeline: BootMark[]): Promise<void> {
  const ctx = sandboxRelayContext()
  if (!ctx) return
  if (timeline.length === 0) return
  const { sessionId, token, apiRoot } = ctx
  const url = `${apiRoot}/platform/boot-timeline`
  const body: BootTimelineRelayBody = { session_id: sessionId, timeline }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      // Feed the shared dead-session-credential breaker (KRTX-446): a terminal
      // 401 here is one more signal on the streak; any other answer clears it.
      noteControlPlaneResponse(res.status, await res.text().catch(() => ''))
      logger.warn('[boot] boot-timeline relay non-ok', { status: res.status })
      return
    }
    noteControlPlaneResponse(res.status, null)
    logger.info('[boot] boot timeline relayed to api', { marks: timeline.length })
  } catch (err) {
    logger.warn('[boot] boot-timeline relay failed', { err: (err as Error).message })
  }
}
