/**
 * Did the prompt reach the agent before the connection gave up?
 *
 * `POST /session/:id/command` blocks until the whole turn finishes, and two
 * proxy hops sit between the browser and opencode. Either can stop waiting
 * while opencode is still working perfectly well:
 *
 *   - the sandbox daemon answers `502 {"error":"upstream unreachable"}` once its
 *     header wait elapses (`kortix-sandbox-agent-server/src/proxy.ts`)
 *   - apps/api answers `504 LONG_TURN_PROXY_TIMEOUT`, or `502 sandbox upstream
 *     unreachable` on an ambiguous failure it explicitly believes was accepted
 *     (`promptDeliveryMaybeAccepted`, `sandbox-proxy/routes/preview.ts`)
 *
 * In every one of those the request was already ON THE WIRE — what expired was
 * the wait for a RESPONSE, not the delivery. The turn is running and the SSE
 * stream carries it. Rendering that as a failed command is wrong twice: it
 * tells the user their message did not send when it did, and it invites the
 * retry that actually does damage, because a second prompt arriving mid-turn
 * aborts the one already running and stamps it "Interrupted".
 *
 * The inverse cases must stay failures, and they are distinguishable: a refusal
 * BEFORE delivery names itself (`opencode not ready`, a 401/403, a billing 402,
 * a connector gate). Those are listed explicitly rather than inferred, because
 * the cost of guessing wrong here is a silently dropped message.
 */

/**
 * Transport gave up waiting for a response it had already asked for.
 *
 * `sandbox port unreachable` is NOT one of these, and the one-word gap between
 * it and `sandbox upstream unreachable` is the whole reason it is called out
 * here rather than silently absent. Both come out of `portUnreachableResponse`
 * in `apps/api/src/sandbox-proxy/routes/preview.ts`, and only one of them says
 * anything about a prompt:
 *
 *   - `sandbox upstream unreachable` (preview.ts:1546) is the final giveup, and
 *     for a prompt delivery it is reached with `promptDeliveryMaybeAccepted`
 *     still true — the box may already hold the message. Delivered. It matches
 *     the `upstream unreachable` entry below.
 *   - `sandbox port unreachable` (preview.ts:1370) is guarded by
 *     `!promptDelivery && isBrowserNavigation(...)`. It is the dead-preview-port
 *     answer to a BROWSER NAVIGATION — a prompt POST can never receive it, and
 *     nothing about a dead port implies the agent saw anything.
 *
 * Listing the port case as "delivered" therefore bought nothing and cost the
 * failure toast for any mutation aimed at a dead port: the send would be
 * silently swallowed while the user waited for a turn that was never running.
 */
const DELIVERED_BUT_DISCONNECTED = [
  'upstream unreachable',
  'long_turn_proxy_timeout',
  'outran this connection',
];

/**
 * The upstream refused BEFORE opencode saw anything. These win over the list
 * above — `opencode not ready` is a 503 the daemon returns without ever
 * forwarding, so nothing was delivered and the message really is lost.
 */
const REFUSED_BEFORE_DELIVERY = [
  'opencode not ready',
  'sandbox runtime not ready',
  'initial_opencode_session',
  'econnrefused',
  'connection refused',
  'unauthorized',
  'forbidden',
  'authentication rejected',
  'insufficient credits',
  'payment required',
  'subscription',
  'duplicate',
];

export function isDeliveredButDisconnected(message: string | null | undefined): boolean {
  if (!message) return false;
  const lower = message.toLowerCase();
  if (REFUSED_BEFORE_DELIVERY.some((p) => lower.includes(p))) return false;
  return DELIVERED_BUT_DISCONNECTED.some((p) => lower.includes(p));
}

/** Pull a comparable message out of whatever the send path threw. */
export function errorMessageOf(err: unknown): string {
  if (!err) return '';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  if (typeof err === 'object') {
    const rec = err as Record<string, unknown>;
    for (const key of ['message', 'error', 'detail', 'details']) {
      const value = rec[key];
      if (typeof value === 'string' && value) return value;
    }
    try {
      return JSON.stringify(err);
    } catch {
      return '';
    }
  }
  return String(err);
}
