/**
 * "This session's box just went active", inside one API process.
 *
 * A prompt delivered to a booting session polls the session open every 3 s
 * until it is ready, so it starts 1.5 s late on average. Provisioning runs in
 * the process that created the session, and so does the drain that holds the
 * session's first prompt: the provision signals here and the waiting delivery
 * re-opens at once.
 *
 * An optimisation, never an authority. A delivery in another process, or a
 * signal nobody waited for, changes nothing: the poll still runs.
 *
 * A leaf module (no imports): provisioning and the delivery both import it.
 */
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
