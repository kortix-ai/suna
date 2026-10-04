/**
 * Shared bounds for the periodic sweeps (./reaping/*,
 * ../billing/services/compute-invariant-sweep.ts). Their own module so those
 * can import them without a cycle.
 */

export const REAP_BATCH_SIZE = 100;
export const REAP_CONCURRENCY = 6;

/**
 * How old an accepted turn record must be before "no assistant message, root
 * idle" counts as an ORPHANED PROMPT rather than a turn that is merely starting.
 *
 * The daemon's `turn_orphaned_prompt` is a statement about the messages on
 * record, and for a few moments after OpenCode ACKs a prompt those messages look
 * identical to a dropped one: the user message exists, nothing has answered it,
 * and `/session/status` has not flipped busy yet. Redelivering into that window
 * runs the prompt twice. 30s is far past that window — a root that is genuinely
 * working reports busy, which is `inFlight: true` and never reaches here — and
 * still well inside one reaper pass, so it costs a dropped prompt nothing.
 */
export const ORPHANED_PROMPT_MIN_AGE_MS = 30_000;

export function positiveEnvInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Rows examined per reaper pass. A cap is fine — a cap that can never reach a
 *  row is not, which is what the ORDER BY in the candidate query fixes. */
export function reapBatchSize(): number {
  return positiveEnvInt('KORTIX_REAP_BATCH_SIZE', REAP_BATCH_SIZE);
}

/** No single compute window may exceed this, whatever the provider claims. */
export function computeMaxWindowMs(): number {
  return positiveEnvInt('KORTIX_COMPUTE_MAX_WINDOW_HOURS', 24) * 3_600_000;
}

/** How long a box may stay continuously unresolvable before billing closes. */
export function computeUnresolvedCeilingMs(): number {
  return positiveEnvInt('KORTIX_COMPUTE_UNRESOLVED_CEILING_MINUTES', 60) * 60_000;
}
