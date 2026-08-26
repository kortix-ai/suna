/**
 * The second read that confirms — or clears — a deferred mid-turn park.
 *
 * `decideStoppedObservation` (reaping/sandbox-state-sync.ts) deliberately
 * refuses to park a box that still holds turn authority on ONE provider
 * `stopped` read: `stopping` and `pending_stop` both map to `stopped`, and a
 * single misread destroyed a live turn on 2026-08-17. A second read one
 * confirmation window later is what earns the park.
 *
 * That design assumes SOMEBODY reads again. Two observers do — the reaper's
 * status poll and `/start` — and neither is guaranteed: `/start` stops being
 * polled the moment the client gives up, and the reaper visits on its own
 * schedule. Essentia 2026-08-26, session 29861dfa / box inqwpv4a1cc1kynlg46k8:
 * `/start` answered 202, the E2B resume silently failed, and the rows read
 * `running` for 5+ minutes while the provider said
 * `sandbox … is not running (status: stopped)`. Delivery believed the row and
 * burned the queued prompt against a box that was not there.
 *
 * So the observer that DEFERS the park now owns the confirmation: it schedules
 * exactly one bounded re-check. The re-check re-reads the provider — it never
 * acts on the stale observation — so it can only:
 *   - confirm the park, reconciling the row to provider truth, or
 *   - find the box running, which drops the marker via the normal path.
 *
 * It CANNOT manufacture an active row and it cannot park without a fresh
 * provider read, so it adds no phantom-active window. Best-effort by
 * construction: a lost timer costs the row nothing, because the reaper's own
 * pass still reaches it.
 */

export interface StoppedObservationFollowUp {
  externalId: string;
  sandboxId: string;
  /** Provider truth, re-read at follow-up time. Never the caller's old read. */
  getStatus: () => Promise<string>;
  /** `reconcileSandboxStoppedByExternalId(externalId, now, {confirmMidTurnStop:true})` */
  reconcile: (now: Date) => Promise<boolean>;
  /** Delay before the re-read. Defaults to one confirmation window + 1s. */
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export type StoppedObservationFollowUpResult =
  | 'reconciled'
  | 'still-open'
  | 'provider-running'
  | 'duplicate';

/**
 * One confirmation window, plus a second so the window has demonstrably closed
 * by the time `decideStoppedObservation` is asked again.
 */
export const STOPPED_OBSERVATION_FOLLOW_UP_MS = 61_000;

/** In-flight follow-ups, so a 1/s `/start` poll schedules exactly one. */
const inFlight = new Set<string>();

export async function runStoppedObservationFollowUp(
  input: StoppedObservationFollowUp,
): Promise<StoppedObservationFollowUpResult> {
  if (inFlight.has(input.sandboxId)) return 'duplicate';
  inFlight.add(input.sandboxId);
  try {
    const sleep = input.sleep ?? Bun.sleep;
    const now = input.now ?? (() => new Date());
    await sleep(input.delayMs ?? STOPPED_OBSERVATION_FOLLOW_UP_MS);
    // A throwing round trip degrades to `unknown`, which is NOT `stopped`: a
    // network blip must never become the confirmation that parks a live box.
    const status = await input.getStatus().catch(() => 'unknown');
    if (status !== 'stopped') return 'provider-running';
    return (await input.reconcile(now())) ? 'reconciled' : 'still-open';
  } finally {
    inFlight.delete(input.sandboxId);
  }
}

/** Test seam: forget every in-flight follow-up. */
export function resetStoppedObservationFollowUps(): void {
  inFlight.clear();
}
