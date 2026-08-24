import { logger } from './logger'
import type { BootMark } from './routes/health'

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
 * routes/health.ts (mirrors relayBootstrapPinToApi, which fires at the
 * analogous "session is usable" point for the bootstrap pin). Do not call it
 * more than once per boot; do not call it from the warm-seed capture path
 * (a seed has no session yet — `KORTIX_SESSION_ID` is unset there and the
 * relay below is a no-op anyway, but the extra call is still needless work).
 *
 * Fire-and-forget, non-blocking, and bounded by a timeout — never awaited by
 * the caller and never throws, so a slow or unreachable control plane can
 * never add latency to (or fail) boot. Mirrors relayBootstrapPinToApi's auth:
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
  const projectId = process.env.KORTIX_PROJECT_ID?.trim()
  const sessionId = process.env.KORTIX_SESSION_ID?.trim()
  // The API accepts this session-bound credential for daemon lifecycle events.
  const token = (process.env.KORTIX_TOKEN || '').trim()
  const apiUrl = process.env.KORTIX_API_URL?.replace(/\/$/, '')
  if (!projectId || !sessionId || !token || !apiUrl) return
  if (timeline.length === 0) return
  const apiRoot = apiUrl.endsWith('/v1') ? apiUrl : `${apiUrl}/v1`
  const url = `${apiRoot}/platform/boot-timeline`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ session_id: sessionId, timeline }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      logger.warn('[boot] boot-timeline relay non-ok', { status: res.status })
      return
    }
    logger.info('[boot] boot timeline relayed to api', { marks: timeline.length })
  } catch (err) {
    logger.warn('[boot] boot-timeline relay failed', { err: (err as Error).message })
  }
}
