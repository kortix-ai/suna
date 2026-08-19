/**
 * The ports opencode can be listening on inside a sandbox.
 *
 * It is a PAIR, not a single port. The daemon's verified reload boots the new
 * opencode on the idle half, proves it serves, and only then swaps to it and
 * retires the old one (see `apps/kortix-sandbox-agent-server/src/opencode.ts`).
 * Either half can therefore be the live one at any moment, and which is live
 * flips every time a session reloads its config.
 *
 * Anything that treats "is this opencode?" as a port comparison has to ask this
 * module, because `4096` alone is only half an answer. Two protections were
 * written against the single port and would have gone quiet on the other half:
 *
 *   - `PUBLIC_SHARE_BLOCKED_PORTS` — a public share must never expose the
 *     conversation API. Blocking one half leaves the session shareable through
 *     the other after a single reload.
 *   - `isPreviewUseObservation` (sandbox-deadline-policy) — opencode traffic is
 *     EXCLUDED from preview-use observation on purpose: the box's own agent
 *     chatter must not read as a human using a preview and extend the deadline.
 *     Counting the other half would let a session keep itself alive, which is
 *     the self-renewal the bounded-lifetime design exists to prevent.
 *
 * Kept in sync with `KORTIX_OPENCODE_INTERNAL_PORT` / `KORTIX_OPENCODE_STANDBY_PORT`
 * in the daemon's config.ts. These are the deployed defaults; the daemon allows
 * overrides, but nothing in this repo sets them.
 */

/** Live half by default — the port opencode boots on. */
export const OPENCODE_PRIMARY_PORT = 4096;

/** Idle half — becomes live after a verified reload swaps onto it. */
export const OPENCODE_STANDBY_PORT = 4097;

/** Every port opencode may be serving the session API on. */
export const OPENCODE_PORTS: ReadonlySet<number> = new Set([
  OPENCODE_PRIMARY_PORT,
  OPENCODE_STANDBY_PORT,
]);

/** True when this port carries opencode's session API, on either half. */
export function isOpencodePort(port: number): boolean {
  return OPENCODE_PORTS.has(port);
}
