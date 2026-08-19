/**
 * Idempotency guard for `setSessionAgentName`.
 *
 * `setSessionAgentName` writes to a `useSyncExternalStore`-backed store whose
 * snapshot identity changes on every write (a fresh `sessionAgentName` record).
 * Without a read-then-write guard, any render/effect path that re-fires the
 * setter with the SAME value drives an infinite render loop — React #185
 * ("Maximum update depth exceeded"). See Better Stack pattern
 * `351da94339c2eed61380ce8ef1c9e78c7afed102bc18707ef65c36f3049887eb`, which
 * surfaced as `Object.setSessionAgentName` in the co-worker session page.
 *
 * Returning `false` here (no-op when the value is unchanged) is what breaks
 * the loop: no store mutation → no snapshot change → no re-render → no re-fire.
 */
export function shouldSetSessionAgentName(
  current: string | undefined,
  next: string | undefined,
): boolean {
  // Normalize so `undefined` (delete) and `''` (falsy → delete) are treated as
  // the same "clear" intent, matching the setter's `if (name) ... else delete`.
  const normalizedNext = next ? next : undefined;
  const normalizedCurrent = current ? current : undefined;
  return normalizedNext !== normalizedCurrent;
}
