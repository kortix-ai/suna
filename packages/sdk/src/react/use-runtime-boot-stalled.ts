'use client';

import { useEffect, useState } from 'react';
import { useSandboxConnectionStore } from '../browser/stores/sandbox-connection-store';
import { START_INCONCLUSIVE_GIVE_UP_MS } from './use-session';

/**
 * The same ceiling the `/start` poll uses to decide a boot attempt is no longer
 * "in progress", now DERIVED from it rather than hand-copied and kept in sync
 * by a comment. The two give-up clocks — server-side `/start` staying
 * inconclusive, client-side runtime never turning healthy — cannot disagree
 * about how long "still starting" gets to mean.
 *
 * It claims no turn and no health truth: `ready` is false either way
 * (`session-composer-readiness.ts`). It is only the bound on the documented
 * wedged-503 shape, where `classifyProbeResult` maps every 503 to `booting` and
 * resets the probe failure count, so `status` never becomes `'unreachable'` no
 * matter how long the box stays wedged.
 */
export const RUNTIME_BOOT_STALL_MS = START_INCONCLUSIVE_GIVE_UP_MS;

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
