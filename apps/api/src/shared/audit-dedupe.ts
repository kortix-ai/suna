/**
 * Bounded in-memory "first time in this window" gate for audit rows that only
 * need to record that something happened at least once per window.
 *
 * Same shape as `jwt-liveness.ts`: a Map with a hard size cap (oldest entry
 * evicted first) and a TTL. State is per API replica and lost on restart, so
 * the guarantee is "at least one row per key per window per replica", never
 * "exactly one". A new key, or a key whose window expired, is always admitted.
 */
export const AUDIT_DEDUPE_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 10_000;

export function createFirstInWindow(
  opts: { windowMs?: number; maxEntries?: number; now?: () => number } = {},
): (key: string) => boolean {
  const { windowMs = AUDIT_DEDUPE_WINDOW_MS, maxEntries = DEFAULT_MAX_ENTRIES, now = Date.now } = opts;
  const seenAt = new Map<string, number>();
  return (key) => {
    const t = now();
    const prev = seenAt.get(key);
    if (prev !== undefined && t - prev < windowMs) return false;
    seenAt.delete(key); // re-insert so Map order stays oldest-first
    if (seenAt.size >= maxEntries) seenAt.delete(seenAt.keys().next().value as string);
    seenAt.set(key, t);
    return true;
  };
}
