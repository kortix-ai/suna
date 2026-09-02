/**
 * Is this error the ENVIRONMENT being gone, or the operation legitimately
 * failing?
 *
 * The whole re-attach contract turns on this one question, and the code gives
 * us a poor signal to answer it with: `KortixExecutionEnv.rpcOnce` catches
 * everything — *"Never throw. A dead environment is a Result, not an
 * exception."* — so a box that no longer exists and a file that does not
 * exist come back in exactly the same shape.
 *
 * What separates them is that the daemon, when it answers at all, answers with
 * a MAPPED code. `not-found`, `permission`, `exists` — those are the daemon
 * saying "I ran your operation and here is what happened". `unknown` plus a
 * transport-shaped message is the opposite: nothing on the far side spoke.
 *
 * The bias is deliberate. A false positive costs one `ensure` and one retry,
 * both idempotent. A false negative is the permanent wedge this exists to
 * remove — every later tool call in that session failing against a box the
 * control plane would gladly resume.
 */

/** Transport failures, as the runtimes actually word them. */
const UNREACHABLE = [
  /fetch failed/i,
  /ECONNREFUSED/i,
  /ECONNRESET/i,
  /EPIPE/i,
  /EHOSTUNREACH/i,
  /ENOTFOUND/i,
  /socket/i,
  /\bclosed\b/i,
  /\btimeout\b/i,
  /\bterminated\b/i,
  /unable to connect/i,
  /\b(502|503|504)\b/,
];

export function isEnvironmentUnreachable(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  // A mapped code means the daemon ran the operation and reported on it —
  // including `environment_unavailable`, which attach() already retried to its
  // own deadline and which re-attaching would only make slower.
  if (code !== 'unknown') return false;
  if (typeof message !== 'string' || message.length === 0) return false;
  return UNREACHABLE.some((pattern) => pattern.test(message));
}
