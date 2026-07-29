/**
 * Ports whose traffic is the SESSION's conversation, not arbitrary user code.
 *
 * Two ports carry it, and the difference between them is a provider detail:
 *
 *   - 8000 — the in-box agent daemon (OpenCode REST/SSE + owner-synced secrets)
 *   - 4096 — opencode's own HTTP/SSE server, reached DIRECTLY on Daytona
 *
 * Platinum's `routeIngress` rewrites 4096 → 8000, so a Platinum request is gated
 * as :8000 whatever the client addressed. Daytona's `routeIngress` is a
 * pass-through (`{ effectivePort: request.port }`), so on Daytona — the primary
 * provider — a request to :4096 stays :4096.
 *
 * That is why gating on `upstreamPort === 8000` alone was a cross-end-user leak.
 * Sandbox ownership is still enforced unconditionally upstream of this, but in
 * Kortix-as-a-Backend every session shares ONE `created_by` (the wrapper's
 * credential), so an ownership check cannot separate end-users — the per-SESSION
 * gate is what does that, via `callerSessionId`. Skipping it for :4096 handed
 * end-user A's sandbox token a path to end-user B's conversation on Daytona.
 *
 * `PUBLIC_SHARE_BLOCKED_PORTS` (shared/session-public-shares.ts) already treats
 * 4096 and 8000 as equally sensitive. This is the same judgement, applied to the
 * gate that had drifted from it.
 */
export const SESSION_DATA_PORTS: ReadonlySet<number> = new Set([8000, 4096]);

/** True when this EFFECTIVE upstream port serves the session's conversation and
 *  must therefore pass the per-session visibility gate. */
export function carriesSessionData(upstreamPort: number): boolean {
  return SESSION_DATA_PORTS.has(upstreamPort);
}
