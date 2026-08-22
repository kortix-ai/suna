/**
 * Per-key coalescing for the env hot-push fan-out.
 *
 * INCIDENT 2026-08-21: two projects wrote secrets in a loop (one 1,017 writes in
 * a morning, one 3→164/hr in an evening). Every write fanned an env push to
 * every active sandbox in the project — 104 and 183 of them — through the
 * provider's API, which throttled the whole org (`ThrottlerException`), and
 * with it every other customer's session create and wake. The pushes carried
 * identical state: only the LAST snapshot matters, because each run re-resolves
 * the project's secrets at start.
 *
 * So: at most one run per key in flight, at most one run per key per
 * `minIntervalMs`, and every caller that arrives while a run is in flight or
 * the interval is cooling down awaits ONE shared trailing run. That trailing
 * run starts after the current run settles and the interval allows, resolves
 * its own fresh snapshot, and therefore includes every write that queued it.
 * A burst of N writes costs 2 runs (leading + trailing), not N.
 *
 * `refreshModels` is merged with OR across coalesced callers — any one caller
 * needing the heavier refresh makes the shared run do it; dropping it for the
 * others would silently skip work they were promised.
 *
 * A rejected run rejects exactly the callers awaiting it and leaves the state
 * clean — the next call starts fresh instead of inheriting a poisoned promise.
 */

export interface CoalescedRunOpts {
  refreshModels?: boolean;
}

interface KeyState<T> {
  inFlight: Promise<T> | null;
  lastStartMs: number;
  pending: {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (err: unknown) => void;
    refreshModels: boolean;
  } | null;
  timer: ReturnType<typeof setTimeout> | null;
}

export function createCoalescedRunner<T>(input: {
  run: (key: string, opts: { refreshModels: boolean }) => Promise<T>;
  /** Read at decision time so config/test changes apply without rebuild. */
  minIntervalMs: () => number;
}): (key: string, opts?: CoalescedRunOpts) => Promise<T> {
  const states = new Map<string, KeyState<T>>();

  function state(key: string): KeyState<T> {
    let s = states.get(key);
    if (!s) {
      s = { inFlight: null, lastStartMs: 0, pending: null, timer: null };
      states.set(key, s);
    }
    return s;
  }

  function startRun(s: KeyState<T>, key: string, refreshModels: boolean): Promise<T> {
    s.lastStartMs = Date.now();
    const run = input.run(key, { refreshModels });
    s.inFlight = run;
    run
      .catch(() => {})
      .finally(() => {
        if (s.inFlight === run) s.inFlight = null;
        maybeStartPending(s, key);
      });
    return run;
  }

  function maybeStartPending(s: KeyState<T>, key: string): void {
    if (!s.pending || s.inFlight) return;
    const waitMs = s.lastStartMs + input.minIntervalMs() - Date.now();
    if (waitMs > 0) {
      if (!s.timer) {
        s.timer = setTimeout(() => {
          s.timer = null;
          maybeStartPending(s, key);
        }, waitMs);
        // A queued trailing run must never pin the process open on its own.
        s.timer.unref?.();
      }
      return;
    }
    const pending = s.pending;
    s.pending = null;
    if (s.timer) {
      clearTimeout(s.timer);
      s.timer = null;
    }
    startRun(s, key, pending.refreshModels).then(pending.resolve, pending.reject);
  }

  return (key: string, opts?: CoalescedRunOpts): Promise<T> => {
    const s = state(key);
    const refreshModels = opts?.refreshModels === true;

    if (s.pending) {
      s.pending.refreshModels ||= refreshModels;
      return s.pending.promise;
    }
    if (!s.inFlight && Date.now() - s.lastStartMs >= input.minIntervalMs()) {
      return startRun(s, key, refreshModels);
    }
    let resolve!: (value: T) => void;
    let reject!: (err: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    s.pending = { promise, resolve, reject, refreshModels };
    maybeStartPending(s, key);
    return promise;
  };
}
