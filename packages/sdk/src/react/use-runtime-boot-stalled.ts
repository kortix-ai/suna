'use client';

import { useEffect, useState } from 'react';
import { useSandboxConnectionStore } from '../browser/stores/sandbox-connection-store';

/**
 * Matches `START_INCONCLUSIVE_GIVE_UP_MS` in `use-session.ts` — the same
 * ceiling the `/start` poll already uses to decide a boot attempt is no
 * longer "in progress." Reusing it keeps the two give-up clocks (server-side
 * `/start` staying inconclusive, client-side runtime never turning healthy)
 * from disagreeing about how long "still starting" gets to mean before the
 * UI treats it as stuck.
 */
export const RUNTIME_BOOT_STALL_MS = 45_000;

/**
 * True once the runtime has been reachable-but-not-healthy for at least
 * `thresholdMs` with no ready flip — independent of
 * `useRuntimePhase() === 'unreachable'`.
 *
 * That distinction matters: a sandbox proxy that answers every probe with a
 * 503 (OpenCode wedged mid-boot) is classified `'booting'` on every tick,
 * which resets the failure counter each time (see `classifyProbeResult` /
 * `resetSandboxFail` in `use-runtime-reconnect`). `failCount` can never cross
 * `FAIL_THRESHOLD_*` through that path, so `status` never becomes
 * `'unreachable'` no matter how long the box stays wedged — the composer's
 * "Waking this session up…" notice had no time bound and no escape hatch in
 * that case. This hook gives it one, keyed off `bootingSinceAt` (cleared only
 * when `healthy` actually flips true), so `sessionComposerReadiness` can
 * offer a manual retry even when the probe layer itself never gives up.
 */
export function useRuntimeBootStalled(thresholdMs: number = RUNTIME_BOOT_STALL_MS): boolean {
  const bootingSinceAt = useSandboxConnectionStore((s) => s.bootingSinceAt);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (bootingSinceAt === null) return;
    const interval = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(interval);
  }, [bootingSinceAt]);

  if (bootingSinceAt === null) return false;
  return now - bootingSinceAt >= thresholdMs;
}
