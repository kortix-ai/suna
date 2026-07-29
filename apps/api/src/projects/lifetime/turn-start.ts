/**
 * BOUNDED SANDBOX LIFETIME — W2's classifier: "is this request a TURN START?"
 *
 * THE DISCOVERY THE WHOLE DESIGN RESTS ON is that run boundaries already exist
 * and are already observed. `sandbox-proxy/preview-retry-budget.ts` has matched
 * the prompt path since long before this feature, and its own comment calls it
 * "OpenCode's synchronous, blocking turn". The platform had a precise
 * turn-boundary system and wired it only to chat notifications, while sandbox
 * LIFETIME ran on a weaker, self-reported, unbounded lease.
 *
 * One pure function, no I/O, no DB, no clock — so it is exhaustively testable
 * and a tenth path is a one-line reviewed change.
 *
 * DO NOT reuse `isLongTurnCompletionRequest` from preview-retry-budget.ts: it
 * matches only `/message`, while every real client uses `prompt_async`. And do
 * NOT widen `shouldSyncProjectEnvBeforeProxy` instead of adding this — that
 * would give `/command` and `/summarize` an env pre-sync round-trip they do not
 * need, on the hot prompt path.
 */

/** opencode's own HTTP port. Daytona reaches it directly; Platinum re-routes. */
export const OPENCODE_INTERNAL_PORT = 4096;
/** The in-box sandbox agent, which reverse-proxies everything to 4096. */
export const SANDBOX_AGENT_PORT = 8000;

/**
 * `/command` and `/summarize` are here because both start a real, billable
 * opencode turn — a classifier that admits only `prompt_async`/`message` would
 * kill a box mid-`/command`.
 */
const TURN_START_PATH = /^\/session\/[^/]+\/(?:prompt_async|message|command|summarize)(?:$|[/?#])/;

/** The ACP envelope route shape as it appears through the sandbox proxy. */
const ACP_PATH = /^\/kortix\/acp(?:$|[/?#])/;

/**
 * Strip in-box dynamic-port proxy nesting (`/proxy/4096/session/...`). The
 * sandbox agent exposes arbitrary in-box ports under this prefix, and a prompt
 * addressed that way is the same turn start as one addressed directly.
 */
export function unwrapProxyPrefix(path: string): string {
  return path.replace(/^\/proxy\/\d+(?=\/)/, '');
}

/**
 * True when this request STARTS a turn — i.e. when the control plane is
 * OBSERVING work begin, as opposed to inferring it from something the sandbox
 * told us.
 *
 * Observation alone is not sufficient to extend a deadline: the caller must
 * ALSO clear `observeExtension`, because the box holds a credential that
 * produces a perfectly valid principal for requests it authors itself.
 */
export function isTurnStartRequest(port: number, method: string, path: string): boolean {
  if (method.toUpperCase() !== 'POST') return false;
  if (port !== SANDBOX_AGENT_PORT && port !== OPENCODE_INTERNAL_PORT) return false;
  const unwrapped = unwrapProxyPrefix(path);
  return TURN_START_PATH.test(unwrapped) || ACP_PATH.test(unwrapped);
}
