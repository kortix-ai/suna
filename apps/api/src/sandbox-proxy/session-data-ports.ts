import { OPENCODE_PORTS } from '../shared/opencode-ports';

/**
 * Ports whose traffic is the SESSION's conversation, not arbitrary user code.
 *
 * The ports that carry it, and the difference between them is a provider detail:
 *
 *   - 8000 — the in-box agent daemon (OpenCode REST/SSE + owner-synced secrets)
 *   - 4096 / 4097 — opencode's own HTTP/SSE server, reached DIRECTLY on Daytona.
 *     A PAIR, because the daemon's verified reload boots the replacement on the
 *     idle half and swaps onto it, so either can be live (shared/opencode-ports).
 *     Listing only 4096 would reopen the leak this module documents below on any
 *     session that has reloaded its config — the gate would wave the live port
 *     through as ordinary user code.
 *
 * Platinum's `routeIngress` rewrites 4096 → 8000, so a Platinum request is gated
 * as :8000 whatever the client addressed. Daytona's `routeIngress` is a
 * pass-through (`{ effectivePort: request.port }`), so on Daytona — the primary
 * provider — a request to :4096 stays :4096.
 *
 * That is why gating on `upstreamPort === 8000` alone was a cross-end-user leak.
 * Sandbox ownership is still enforced unconditionally upstream of this, but in
 * dosco-as-a-Backend every session shares ONE `created_by` (the wrapper's
 * credential), so an ownership check cannot separate end-users — the per-SESSION
 * gate is what does that, via `callerSessionId`. Skipping it for :4096 handed
 * end-user A's sandbox token a path to end-user B's conversation on Daytona.
 *
 * `PUBLIC_SHARE_BLOCKED_PORTS` (shared/session-public-shares.ts) already treats
 * the opencode ports and 8000 as equally sensitive. This is the same judgement, applied to the
 * gate that had drifted from it.
 */
export const SESSION_DATA_PORTS: ReadonlySet<number> = new Set([8000, ...OPENCODE_PORTS]);

/** True when this EFFECTIVE upstream port serves the session's conversation and
 *  must therefore pass the per-session visibility gate. */
export function carriesSessionData(upstreamPort: number): boolean {
  return SESSION_DATA_PORTS.has(upstreamPort);
}

/**
 * The in-box static-file listener (3211).
 *
 * It serves files out of the session's own workspace and has NO authentication
 * of its own — it trusts that whoever reached the port was allowed to. That
 * assumption held while it sat behind `/proxy/3211` inside the box; it does not
 * hold on the public path proxy, which accepts any port a caller names.
 */
export const STATIC_FILE_PORT = 3211;

/**
 * True when the port must pass the per-SESSION visibility gate, not merely the
 * account-membership check.
 *
 * Deliberately wider than `carriesSessionData`. 3211 needs the session gate for
 * the same reason 8000 does — it reads that session's workspace — but it must
 * NOT join SESSION_DATA_PORTS, because that set also drives
 * `shouldAutoResumeStoppedSandbox`, where membership means "only a non-GET may
 * wake the box". Static file serving is all GETs, so folding 3211 in there
 * would stop a parked box from ever waking for a preview: a real regression,
 * and an unrelated one. Two questions, two predicates.
 */
export function requiresSessionVisibility(upstreamPort: number): boolean {
  return carriesSessionData(upstreamPort) || upstreamPort === STATIC_FILE_PORT;
}
