import { config } from '../config';
import { drainSessionLifecycleQueue } from '../projects/session-lifecycle/drain';
import { isPgBroadcastListening, onLifecycleCommandDue } from '../shared/pg-broadcast';

/**
 * The lifecycle drain's clock.
 *
 * With the LISTEN live, a queued row wakes the drain at its own due time: a
 * database trigger NOTIFYs every replica on enqueue, requeue and release
 * (`kortix_lifecycle_command_due`, R9.2). The 1 s tick then drains only when no
 * drain ran for `DRAIN_FALLBACK_MS` — the backstop for a missed NOTIFY. Without
 * the LISTEN it drains every second, as before.
 *
 * `KORTIX_TRIGGER_SCHEDULER_ENABLED=false` switches this off with every other
 * background writer: the prod shadow stack and the local test stack run with no
 * writers on purpose (scripts/prod-us-east-2/target-writers.sh).
 */
export const DRAIN_FALLBACK_MS = 5_000;
/** The least time between two drain starts in one process. A row given back
 *  due now NOTIFYs again; without this gap that loop would spin unthrottled. */
export const MIN_DRAIN_GAP_MS = 1_000;
/** A due time further out than this is left to the fallback tick. */
const MAX_WAKE_DELAY_MS = 10 * 60_000;

const state = globalThis as typeof globalThis & {
  __kortixLifecycleWorker?: ReturnType<typeof setInterval>;
  __kortixLifecycleDrainInFlight?: boolean;
  __kortixLifecycleDrainRerun?: boolean;
  __kortixLifecycleLastDrainAt?: number;
  __kortixLifecycleWake?: { at: number; timer: ReturnType<typeof setTimeout> };
};

/** When a wake for a row due at `dueAtMs` should fire, or null to leave it to the tick. */
export function wakeAt(dueAtMs: number, lastDrainAt: number, now: number): number | null {
  const at = Math.max(dueAtMs, lastDrainAt + MIN_DRAIN_GAP_MS, now);
  return at - now > MAX_WAKE_DELAY_MS ? null : at;
}

function drainNow(): void {
  // One drain per process at a time. A drain delivers prompts over the network
  // (~1.3 s each), so stacked drains starved the DB pool under load.
  if (state.__kortixLifecycleDrainInFlight) {
    state.__kortixLifecycleDrainRerun = true;
    return;
  }
  state.__kortixLifecycleDrainInFlight = true;
  state.__kortixLifecycleDrainRerun = false;
  state.__kortixLifecycleLastDrainAt = Date.now();
  void drainSessionLifecycleQueue({ limit: 10 })
    .catch((error) => {
      console.error('[session-lifecycle] queue drain failed', error);
    })
    .finally(() => {
      state.__kortixLifecycleDrainInFlight = false;
      if (state.__kortixLifecycleDrainRerun) scheduleWake(Date.now());
    });
}

function scheduleWake(dueAtMs: number): void {
  if (!state.__kortixLifecycleWorker) return;
  const now = Date.now();
  const at = wakeAt(dueAtMs, state.__kortixLifecycleLastDrainAt ?? 0, now);
  if (at === null) return;
  const pending = state.__kortixLifecycleWake;
  if (pending && pending.at <= at) return;
  if (pending) clearTimeout(pending.timer);
  const timer = setTimeout(() => {
    state.__kortixLifecycleWake = undefined;
    drainNow();
  }, at - now);
  timer.unref?.();
  state.__kortixLifecycleWake = { at, timer };
}

/** Claims are CAS-protected; delivery runs on every API, independently of cron leadership. */
export function startSessionLifecycleWorker(): void {
  stopSessionLifecycleWorker();
  if (config.KORTIX_TRIGGER_SCHEDULER_ENABLED === false) return;
  const tick = () => {
    const sinceLast = Date.now() - (state.__kortixLifecycleLastDrainAt ?? 0);
    if (isPgBroadcastListening() && sinceLast < DRAIN_FALLBACK_MS) return;
    drainNow();
  };
  state.__kortixLifecycleWorker = setInterval(tick, 1_000);
  onLifecycleCommandDue(scheduleWake);
  drainNow();
}

export function stopSessionLifecycleWorker(): void {
  if (state.__kortixLifecycleWorker) clearInterval(state.__kortixLifecycleWorker);
  state.__kortixLifecycleWorker = undefined;
  if (state.__kortixLifecycleWake) clearTimeout(state.__kortixLifecycleWake.timer);
  state.__kortixLifecycleWake = undefined;
  onLifecycleCommandDue(null);
}
