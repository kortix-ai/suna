/**
 * BOUNDED SANDBOX LIFETIME — the proof type. LAYER 2 OF THE STRUCTURAL GUARD.
 *
 * THE INVARIANT:
 *   A sandbox-reported signal may only SHORTEN a sandbox's life.
 *   Only a control-plane-OBSERVED event may EXTEND it, and only to a ceiling.
 *
 * The whole leak is what happens when that rule is absent. Today the in-box
 * ExecutionLeaseReporter renews a lease every ~60s while opencode believes any
 * session is busy OR retrying; the lease short-circuits the reaper BEFORE it
 * probes; and the same write stamps the fallback activity clock. The sandbox
 * grants itself immortality and erases the evidence that would override it.
 *
 * This module exists so that mistake cannot be re-made by accident. It has one
 * job: make a sandbox-authored value UNUSABLE where an extension is expected.
 *
 * TWO THINGS ARE PROVED, and the second is the one every earlier design missed.
 *
 *  1. PROVENANCE OF THE CLOCK. `observeExtension` reads the clock ITSELF. There
 *     is no way to construct an `ObservedExtension` from a timestamp parsed out
 *     of a request body or a sandbox heartbeat, because the type is branded
 *     with a `unique symbol` that nothing outside this file can name. A future
 *     `extendDeadline(sb, ms, new Date(body.turnStartedAt))` is a COMPILE
 *     ERROR, not a code review finding.
 *
 *  2. PROVENANCE OF THE REQUEST — decided by CREDENTIAL, not by `access.kind`.
 *     The sandbox holds an account executor token carrying its own
 *     `r.sessionId`, and `authenticatePreviewPrincipalDetailed` returns a
 *     perfectly good principal for it. So `access.kind === 'principal'` is TRUE
 *     for a request the BOX ITSELF authored, and a path classifier that looks
 *     only at method/port/path cannot tell the difference. A wedged box running
 *     `curl -X POST -H "Authorization: Bearer $KORTIX_TOKEN" .../prompt_async`
 *     once an hour would otherwise grant itself the turn ceiling forever — a 6x
 *     widening on exactly the zero-usage-event zombie population this design
 *     exists to kill. The same token works on the WS path via `?token=`, so
 *     "keystrokes prove a human is present" was false too.
 *
 *     `PreviewPrincipal.sessionId` is non-null ONLY for a session-bound sandbox
 *     token, which is precisely the discriminator. A credential bound to THIS
 *     session cannot extend THIS session's box.
 *
 * NOTE ON WHAT THIS IS NOT. It is not a claim that the caller is human, and not
 * an authorization check — both of those happen upstream. It is a claim about
 * two provenances, and nothing more.
 */

declare const observed: unique symbol;

/**
 * Proof that the control plane OBSERVED an event that the sandbox did not
 * AUTHOR. The only thing that may EXTEND a sandbox's life.
 *
 * Erased at runtime — it is a `Date` with a phantom brand. Its entire value is
 * at the type level and in the fact that `observeExtension` is its only
 * producer (asserted by architecture.test.ts, layer 3).
 */
export type ObservedExtension = { readonly at: Date } & { readonly [observed]: true };

export interface ObservationInput {
  /**
   * `principal.sessionId` / `access.callerSessionId` — non-null ONLY when the
   * credential is a session-bound sandbox token. Null for a browser JWT, a
   * laptop CLI PAT, a service account, or an account-wide key.
   */
  principalSessionId: string | null;
  /** The session owning the row about to be extended. */
  recordSessionId: string;
}

/**
 * THE ONLY PRODUCER of an `ObservedExtension`.
 *
 * Returns null — rather than throwing — when the request is self-authored, so
 * the call sites degrade to "do not extend" instead of failing a user's prompt.
 * Callers must handle the null; `extendDeadline` takes a NON-nullable proof
 * precisely so that handling cannot be skipped by passing the null through.
 */
export function observeExtension(input: ObservationInput): ObservedExtension | null {
  if (input.principalSessionId !== null && input.principalSessionId === input.recordSessionId) {
    return null;
  }
  return { at: new Date() } as ObservedExtension;
}

/**
 * The control plane observing something with no request credential behind it at
 * all — an internal, server-authored event. Today: W1, the provision anchor,
 * where the API itself authored the initial prompt and there is no inbound
 * request to attribute.
 *
 * Separate from `observeExtension` so it is greppable and so the "no credential
 * to check" case is a deliberate, named decision rather than a `null` that
 * happens to fall through the self-authorship test.
 */
export function observeControlPlaneEvent(): ObservedExtension {
  return { at: new Date() } as ObservedExtension;
}
