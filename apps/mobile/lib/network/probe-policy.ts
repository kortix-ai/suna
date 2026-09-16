/**
 * Reachability probe cadence. One probe a minute while online keeps the radio
 * mostly idle; a failure re-checks after 10 s so recovery shows quickly. One
 * failed probe on a flaky network does not show the offline banner.
 */
export const ONLINE_PROBE_INTERVAL_MS = 60_000;
export const OFFLINE_PROBE_INTERVAL_MS = 10_000;
const FAILURES_BEFORE_OFFLINE = 2;

/** Failure count after a probe: success resets it, failure increments it. */
export function nextFailureCount(consecutiveFailures: number, ok: boolean): number {
  return ok ? 0 : consecutiveFailures + 1;
}

/** Delay before the next probe. `consecutiveFailures` includes this probe. */
export function nextProbeDelay(ok: boolean, consecutiveFailures: number): number {
  return ok && consecutiveFailures === 0 ? ONLINE_PROBE_INTERVAL_MS : OFFLINE_PROBE_INTERVAL_MS;
}

export function shouldShowOffline(consecutiveFailures: number): boolean {
  return consecutiveFailures >= FAILURES_BEFORE_OFFLINE;
}
