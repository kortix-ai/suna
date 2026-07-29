/**
 * BOUNDED SANDBOX LIFETIME — W3b / W3c: progress on the ACP transport.
 *
 * THIS IS NOT AN OPTIMISATION. Without it the model kills every direct-key
 * (BYOK) ACP turn at the turn ceiling, and the shadow gate certifies that as
 * safe, because `last_usage_age_ms` is null for those boxes BY CONSTRUCTION and
 * therefore indistinguishable from "never did anything".
 *
 * `usage_events` does not exist for a large and growing class of sessions:
 *   - the harness registry launches Claude Code with NO ANTHROPIC_BASE_URL when
 *     ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / CLAUDE_CODE_OAUTH_TOKEN is
 *     present, uses `methodId: 'api-key'` for codex, and points pi straight at
 *     api.openai.com. Those names arrive as ordinary project secrets.
 *   - on a self-host instance running BYOK, NO ACP session produces a usage
 *     event, ever.
 *
 * ALL ACP traffic transits the API, in both directions. So the second progress
 * signal rides a transport that is control-plane-mediated by construction.
 *
 * THE INVARIANT HOLDS: the PAYLOAD is sandbox-authored, but the OBSERVATION —
 * "a byte crossed the API for this session" — is the control plane's own, just
 * as it is for W2. It is bounded by the absolute run cap and by `active_since`
 * immutability, so a chatty wedged box buys at most the run cap it would get
 * from the turn ceiling anyway. Self-extension is refused via `observeExtension`
 * on the inbound direction, where a credential exists to check.
 *
 * W3c also closes the APPROVAL-PAUSE hole. `session/request_input` is published
 * with `{ timeoutMs: null }` — an unbounded wait — and the human's answer comes
 * back as a bare JSON-RPC response (`{id, result}`) that can never match
 * `method === 'session/prompt'`. Extending on ANY envelope covers both the
 * question and the answer.
 */

import { PROGRESS_GRANT_MS, TURN_CEILING_MS } from './constants';
import { extendDeadline } from './deadline';
import type { ObservedExtension } from './observation';

/**
 * One extension per session per minute. An ACP session can emit hundreds of
 * envelopes a second during a streaming turn, and every one of them would
 * otherwise be an UPDATE — WAL volume proportional to tokens rather than to
 * turns. The grant is 2h, so a 60s throttle costs at most 60s of window.
 *
 * In-process and per-instance on purpose: it is a write-amplification damper,
 * not a correctness mechanism. Two API pods each extending once a minute is
 * still two writes a minute, and the statement is monotone so a duplicate is a
 * no-op. A shared cache here would add a dependency to a hot path for nothing.
 */
const RELAY_THROTTLE_MS = 60_000;
const lastRelayExtendAtMs = new Map<string, number>();

/**
 * Bounded so a long-lived instance cannot accumulate one entry per session it
 * has ever seen. Evicting the oldest half is fine — a lost entry costs one
 * extra monotone UPDATE, never a wrong decision.
 */
const MAX_TRACKED_SESSIONS = 10_000;

function shouldWriteRelay(sessionId: string, nowMs: number): boolean {
  const previous = lastRelayExtendAtMs.get(sessionId);
  if (previous !== undefined && nowMs - previous < RELAY_THROTTLE_MS) return false;
  if (lastRelayExtendAtMs.size >= MAX_TRACKED_SESSIONS) {
    let dropped = 0;
    const target = Math.floor(MAX_TRACKED_SESSIONS / 2);
    for (const key of lastRelayExtendAtMs.keys()) {
      lastRelayExtendAtMs.delete(key);
      if (++dropped >= target) break;
    }
  }
  lastRelayExtendAtMs.set(sessionId, nowMs);
  return true;
}

/** Test seam. Never called in production code. */
export function resetAcpRelayThrottleForTests(): void {
  lastRelayExtendAtMs.clear();
}

/**
 * A pending-input relay is a turn that is ALIVE and blocked on a human, so it
 * gets the full turn ceiling rather than a progress grant. Two hours is not a
 * defensible overnight window for a question nobody has seen yet. Still capped.
 */
function grantForEnvelope(envelope: Record<string, unknown>): number {
  return envelope.method === 'session/request_input' || envelope.method === 'session/prompt'
    ? TURN_CEILING_MS
    : PROGRESS_GRANT_MS;
}

/**
 * W3b/W3c. Call on EVERY relayed envelope, in EITHER direction.
 *
 * `proof` is null when the inbound request was authored by the box's own
 * session-bound credential — in which case nothing happens, silently and by
 * design. The outbound (agent → client) direction has no request credential to
 * check, so its caller supplies a control-plane observation; that is sound
 * because the API relaying a byte to a waiting client is the control plane's
 * own act, and it is bounded by the cap like everything else.
 *
 * Never throws and never blocks the relay: a deadline is worth strictly less
 * than the envelope it is riding on.
 */
export async function noteAcpRelayProgress(
  sessionId: string,
  envelope: Record<string, unknown>,
  proof: ObservedExtension | null,
): Promise<void> {
  if (!proof) return;
  if (!shouldWriteRelay(sessionId, Date.now())) return;
  await extendDeadline({ sessionId }, grantForEnvelope(envelope), proof).catch((err) =>
    console.warn(
      '[lifetime] ACP relay deadline extension failed for session (shadow mode, non-fatal):',
      err,
    ),
  );
}
