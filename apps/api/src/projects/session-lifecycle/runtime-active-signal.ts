/**
 * "This session's box just went active", for the deliveries waiting on it.
 *
 * A prompt delivered to a booting session polls the session open every 3 s
 * until it is ready, so it starts 1.5 s late on average. Two sources wake it
 * sooner: the provision in this process calls `signalSessionRuntimeActive`
 * directly, and bootstrap feeds it every `kortix_session_changed` NOTIFY
 * (shared/pg-broadcast.ts), which a box row change sends to every replica.
 * Prod runs the API at 9 replicas, and on 2026-10-29 477 of 617 first prompts
 * were delivered by a replica that did not provision the box: they waited
 * p50 1.5 s / p90 3.2 s after the box was ready.
 *
 * A delivery ARMS before it reads the session (`armSessionRuntimeActive`), so
 * a signal that lands while that read is in flight is kept, and the wait that
 * follows returns at once. Registering only for the wait dropped such a signal:
 * the delivery then slept the full 500 ms recheck, or the 3 s poll when the
 * dropped signal was the box going active.
 *
 * An optimisation, never an authority. A missed NOTIFY, or a signal nobody
 * waited for, changes nothing: the poll still runs.
 *
 * A leaf module (no imports): provisioning, the delivery and bootstrap import it.
 */
// replica-local: the armed deliveries of this process. The NOTIFY reaches every
// replica, and a missed one costs only the head start: the poll still runs.
const waiters = new Map<string, Set<() => void>>();

export function signalSessionRuntimeActive(sessionId: string): void {
  for (const wake of [...(waiters.get(sessionId) ?? [])]) wake();
}

/** One armed listener: it records a signal from the moment it is armed. */
export interface SessionRuntimeActiveArm {
  /** `true` at once when a signal landed since arming, else on the next signal; `false` after `ms`. Call once. */
  wait(ms: number): Promise<boolean>;
  /** Unregister. Safe to call more than once, and after `wait` settled. */
  cancel(): void;
}

export function armSessionRuntimeActive(sessionId: string): SessionRuntimeActiveArm {
  let signalled = false;
  let settle: ((signalled: boolean) => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const set = waiters.get(sessionId) ?? new Set<() => void>();
  waiters.set(sessionId, set);
  const remove = () => {
    clearTimeout(timer);
    set.delete(wake);
    if (set.size === 0 && waiters.get(sessionId) === set) waiters.delete(sessionId);
  };
  function wake() {
    signalled = true;
    settle?.(true);
  }
  set.add(wake);
  return {
    wait(ms) {
      if (signalled) {
        remove();
        return Promise.resolve(true);
      }
      return new Promise<boolean>((resolve) => {
        settle = (value) => {
          settle = null;
          remove();
          resolve(value);
        };
        timer = setTimeout(() => settle?.(false), ms);
      });
    },
    cancel() {
      settle?.(false);
      remove();
    },
  };
}

/** Resolves `true` when the session's box went active, `false` after `ms`. */
export function waitForSessionRuntimeActive(sessionId: string, ms: number): Promise<boolean> {
  return armSessionRuntimeActive(sessionId).wait(ms);
}
