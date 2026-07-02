/**
 * Reactive Daytona disk-quota guard.
 *
 * Incident 2026-07-02: the org (shared across prod/dev/staging/laptops) rode
 * its 40000GiB total sandbox-disk quota right up to the edge — non-archived
 * disk (started + stopped + archiving + error states) sat at ~37999GiB —
 * because stopped sandboxes only left disk on Daytona's own auto-archive
 * timer (previously 3 days). Any concurrent create/resume tipped the org over
 * the cap, and EVERY session create/resume org-wide failed with
 * `DaytonaValidationError: Total disk limit exceeded`. Manual recovery
 * (archiving the ~1300 oldest stopped sandboxes) took a human ~20 minutes to
 * notice and fix.
 *
 * This module makes that recovery automatic: any Daytona provider call that
 * hits the disk-quota error triggers ONE org-wide archive sweep (cooldown +
 * single-flight gated so a burst of concurrent failures — the exact shape of
 * the incident — fires one sweep, not a thundering herd). Once triggered, the
 * sweep archives EVERY stopped sandbox it can find (safe, reversible — cold
 * storage, still resumable), not just enough to clear a target buffer: hitting
 * the org-wide quota is rare and severe enough that maximum headroom beats a
 * partial one. It does NOT rescue the request that triggered it; it exists so
 * the NEXT request succeeds instead of every subsequent one failing until a
 * human intervenes.
 *
 * Lowering KORTIX_SANDBOX_AUTOARCHIVE_MINUTES (see config.ts) is the actual
 * fix for steady-state pressure; this is the backstop for whatever gets past
 * it (organic growth, a stuck error-state backlog, a future misconfig).
 */

// Deliberately no runtime import from '../shared/daytona' — only the type,
// which is erased at compile time. Callers (platform/providers/daytona.ts)
// wire in the real list/archive functions explicitly via `deps`. This keeps
// the module free of any Daytona-client/config side effects, which matters
// for testability (a bare `deps` contract needs no module mocking at all).
import type { DaytonaStoppedSandboxSummary } from '../shared/daytona';

/** Hard safety cap on how many sandboxes one sweep pass will even consider —
 *  not a target: every candidate under this cap gets archived. Sized far
 *  above any realistic stopped-sandbox count so it only guards against a
 *  runaway pathological case, never against a real incident. */
const SWEEP_MAX_CANDIDATES = 20_000;
const SWEEP_CONCURRENCY = 8;
/** Minimum time between sweeps — one incident should not trigger a storm of
 *  org-wide list calls from every concurrently-failing request. */
const SWEEP_COOLDOWN_MS = 10 * 60_000;

export interface DiskArchiveSweepResult {
  candidates: number;
  archived: number;
  errors: number;
  freedGib: number;
}

export interface DiskQuotaGuardDeps {
  list: (maxItems: number) => Promise<DaytonaStoppedSandboxSummary[]>;
  archive: (id: string) => Promise<boolean>;
}

/**
 * One archive-sweep pass: page every stopped sandbox org-wide (oldest
 * activity first, up to the SWEEP_MAX_CANDIDATES safety cap) and archive all
 * of them. Side-effecting but dependency-injectable so it is unit-testable
 * without a live Daytona org.
 */
export async function runDiskArchiveSweep(
  deps: DiskQuotaGuardDeps,
): Promise<DiskArchiveSweepResult> {
  const result: DiskArchiveSweepResult = { candidates: 0, archived: 0, errors: 0, freedGib: 0 };

  const candidates = await deps.list(SWEEP_MAX_CANDIDATES);
  result.candidates = candidates.length;
  if (candidates.length === 0) return result;

  let cursor = 0;
  const worker = async () => {
    while (cursor < candidates.length) {
      const sb = candidates[cursor++];
      const ok = await deps.archive(sb.id);
      if (ok) {
        result.archived += 1;
        result.freedGib += sb.disk;
      } else {
        result.errors += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(SWEEP_CONCURRENCY, candidates.length) }, worker));
  return result;
}

let inFlight: Promise<DiskArchiveSweepResult> | null = null;
let lastCompletedAt = 0;

/** Test-only: reset cooldown/in-flight state between unit tests. */
export function __resetDiskQuotaGuardStateForTests(): void {
  inFlight = null;
  lastCompletedAt = 0;
}

/**
 * Reactive trigger — call from any Daytona create/resume catch block once
 * `isDaytonaDiskQuotaError(err)` is true (the caller already knows Daytona is
 * configured, since it just got a Daytona-shaped error). Fire-and-forget: the
 * caller's current request still fails (there is nothing to rescue
 * mid-flight), this only prevents the NEXT one from failing too. Cooldown +
 * single-flight gated; safe to call on every single failure in a burst.
 */
export function triggerEmergencyDiskArchiveSweep(
  reason: string,
  deps: DiskQuotaGuardDeps,
): Promise<DiskArchiveSweepResult> | null {
  if (inFlight) return inFlight;
  if (Date.now() - lastCompletedAt < SWEEP_COOLDOWN_MS) return null;

  console.warn(
    `[disk-quota-guard] disk quota error observed — triggering emergency archive sweep (reason: ${reason})`,
  );
  inFlight = runDiskArchiveSweep(deps)
    .then((result) => {
      console.warn(
        `[disk-quota-guard] sweep complete: archived=${result.archived}/${result.candidates} ` +
          `freed~${result.freedGib.toFixed(0)}GiB errors=${result.errors}`,
      );
      return result;
    })
    .catch((err) => {
      console.error('[disk-quota-guard] sweep failed:', err instanceof Error ? err.message : err);
      return { candidates: 0, archived: 0, errors: 1, freedGib: 0 };
    })
    .finally(() => {
      lastCompletedAt = Date.now();
      inFlight = null;
    });
  return inFlight;
}
