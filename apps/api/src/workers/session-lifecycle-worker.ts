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
/**
 * Drains running at once in one process. A normal drain (~1.3 s per prompt) is
 * never overlapped: stacked drains starved the DB pool. A drain that waits on a
 * cold box runs up to 5 min (`READY_DEADLINE_MS`), and with one slot every other
 * queued row waited behind that boot. Past `DRAIN_STALL_MS` a drain no longer
 * blocks the next one; `MAX_CONCURRENT_DRAINS` bounds the pile. Claims are CAS,
 * so overlapping drains never take the same row.
 */
export const MAX_CONCURRENT_DRAINS = 3;
export const DRAIN_STALL_MS = 15_000;

/** True when a new drain may start, given the start times of the drains running now. */
export function canStartDrain(runningSince: readonly number[], now: number): boolean {
  if (runningSince.length === 0) return true;
  if (runningSince.length >= MAX_CONCURRENT_DRAINS) return false;
  return runningSince.every((startedAt) => now - startedAt >= DRAIN_STALL_MS);
}
/** A due time further out than this is left to the fallback tick. */
const MAX_WAKE_DELAY_MS = 10 * 60_000;
/** Pending due times kept per process; past this the fallback tick covers the rest. */
const MAX_PENDING_WAKES = 1_000;

const state = globalThis as typeof globalThis & {
  __kortixLifecycleWorker?: ReturnType<typeof setInterval>;
  /** Start time of every drain running now. */
  __kortixLifecycleDrains?: number[];
  __kortixLifecycleDrainRerun?: boolean;
  __kortixLifecycleLastDrainAt?: number;
  __kortixLifecycleWake?: { at: number; timer: ReturnType<typeof setTimeout> };
  /** Every due time heard and not yet drained, ascending. One timer serves the earliest. */
  __kortixLifecycleDue?: number[];
};

/** When a wake for a row due at `dueAtMs` should fire, or null to leave it to the tick. */
export function wakeAt(dueAtMs: number, lastDrainAt: number, now: number): number | null {
  const at = Math.max(dueAtMs, lastDrainAt + MIN_DRAIN_GAP_MS, now);
  return at - now > MAX_WAKE_DELAY_MS ? null : at;
}

function drainNow(): void {
  const running = (state.__kortixLifecycleDrains ??= []);
  if (!canStartDrain(running, Date.now())) {
    state.__kortixLifecycleDrainRerun = true;
    return;
  }
  const startedAt = Date.now();
  running.push(startedAt);
  state.__kortixLifecycleDrainRerun = false;
  state.__kortixLifecycleLastDrainAt = startedAt;
  void drainSessionLifecycleQueue({ limit: 10 })
    .catch((error) => {
      console.error('[session-lifecycle] queue drain failed', error);
    })
    .finally(() => {
      running.splice(running.indexOf(startedAt), 1);
      if (state.__kortixLifecycleDrainRerun) scheduleWake(Date.now());
    });
}

function scheduleWake(dueAtMs: number): void {
  if (!state.__kortixLifecycleWorker) return;
  const due = (state.__kortixLifecycleDue ??= []);
  if (wakeAt(dueAtMs, 0, Date.now()) === null) return;
  // Keep every due time: a later row must not lose its wake to an earlier one.
  if (due.length < MAX_PENDING_WAKES && !due.includes(dueAtMs)) {
    due.splice(due.findIndex((at) => at > dueAtMs) >>> 0, 0, dueAtMs);
  }
  armWake();
}

/** One timer, for the earliest pending due time. */
function armWake(): void {
  const due = state.__kortixLifecycleDue ?? [];
  const now = Date.now();
  if (due.length === 0) return;
  const at = wakeAt(due[0]!, state.__kortixLifecycleLastDrainAt ?? 0, now)!;
  const pending = state.__kortixLifecycleWake;
  if (pending && pending.at <= at) return;
  if (pending) clearTimeout(pending.timer);
  const timer = setTimeout(() => {
    state.__kortixLifecycleWake = undefined;
    // This drain claims every row due by now; the later ones keep their wake.
    const cutoff = Date.now();
    state.__kortixLifecycleDue = due.filter((dueAt) => dueAt > cutoff);
    drainNow();
    armWake();
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
  state.__kortixLifecycleDue = [];
  onLifecycleCommandDue(null);
}
