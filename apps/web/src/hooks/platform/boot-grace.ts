/**
 * How long a sandbox may keep answering /kortix/health with 503 ("proxy up,
 * OpenCode not ready") before we stop treating it as *booting* and treat it as
 * *stopped/stuck*. A genuine boot flips healthy within a few tens of seconds; a
 * stopped box answers 503 forever. Without this bound that 503 was classified
 * as "connected + booting" and fast-polled every 150ms FOREVER, and because
 * everything is gated on the flapping `healthy` flag, the session page fell into
 * an endless refresh/reconnect storm. Standalone pure module so it can be
 * unit-tested without the 'use client' hook's React/store dependencies.
 */
export const BOOT_GRACE_MS = 120_000;

/**
 * True once a sandbox has been continuously "not ready" for longer than the
 * boot grace window — i.e. it's stopped/stuck, not booting, so we should stop
 * fast-polling it. `unhealthySince` is null when the runtime was last seen
 * healthy (no active boot window).
 */
export function isBootGraceExpired(
  unhealthySince: number | null,
  now: number,
  graceMs: number = BOOT_GRACE_MS,
): boolean {
  if (unhealthySince === null) return false;
  return now - unhealthySince > graceMs;
}
