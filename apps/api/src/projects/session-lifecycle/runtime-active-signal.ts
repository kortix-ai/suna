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
 * An optimisation, never an authority. A missed NOTIFY, or a signal nobody
 * waited for, changes nothing: the poll still runs.
 *
 * A leaf module (no imports): provisioning, the delivery and bootstrap import it.
 */
// replica-local: the waiters of this process. The NOTIFY reaches every
// replica, and a missed one costs only the head start: the poll still runs.
const waiters = new Map<string, Set<() => void>>();

export function signalSessionRuntimeActive(sessionId: string): void {
  for (const wake of waiters.get(sessionId) ?? []) wake();
}

/** Resolves `true` when the session's box went active, `false` after `ms`. */
export function waitForSessionRuntimeActive(sessionId: string, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const set = waiters.get(sessionId) ?? new Set<() => void>();
    waiters.set(sessionId, set);
    const settle = (signalled: boolean) => {
      clearTimeout(timer);
      set.delete(wake);
      if (set.size === 0) waiters.delete(sessionId);
      resolve(signalled);
    };
    const wake = () => settle(true);
    const timer = setTimeout(() => settle(false), ms);
    set.add(wake);
  });
}
