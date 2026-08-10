/**
 * Shared bounds for the periodic sweeps (./reaping/*,
 * ../billing/services/compute-invariant-sweep.ts). Their own module so those
 * can import them without a cycle.
 */

export const REAP_BATCH_SIZE = 100;
export const REAP_CONCURRENCY = 6;

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
