/**
 * An awaitable view of a reactive "still loading" flag.
 *
 * A send gate that reads a loading flag has three honest options: refuse, run
 * anyway, or WAIT. Refusing is wrong whenever the answer is seconds away and
 * the user has already committed the action — that is how the project-home
 * composer lost prompts on a slow API (see `pending-gate.test.ts`). This turns
 * "not in yet" into something an async handler can await, so the decision is
 * made against the real answer instead of against its absence.
 *
 * Deliberately framework-free: React owns the flag, this owns the waiters.
 * The hook wrapper is `useSettledWhenReady` in `use-pending-gate.ts`.
 */
export interface PendingGate {
  /** Report the flag's current value. Called from a render or an effect. */
  set: (pending: boolean) => void;
  /** The flag's current value. */
  pending: () => boolean;
  /**
   * Wait for the flag to go false.
   *
   * Resolves `true` when it settled, `false` when `timeoutMs` elapsed first.
   * A send path must never wait forever — a query that retries for a long time
   * would leave the composer wedged with no toast and no way to retry, which
   * is worse than the refusal this replaces. On `false` the caller refuses,
   * exactly as it did before.
   */
  settled: (timeoutMs?: number) => Promise<boolean>;
}

/** Long enough for a slow API round trip, short enough not to feel stuck. */
export const PENDING_GATE_TIMEOUT_MS = 15_000;

export function createPendingGate(initiallyPending: boolean): PendingGate {
  let pending = initiallyPending;
  let waiters: Array<() => void> = [];

  return {
    set(next: boolean) {
      pending = next;
      if (next || waiters.length === 0) return;
      // Swap the list out BEFORE resolving. A waiter's continuation can call
      // `set` again, and draining a list we still hold would wake it twice.
      const woken = waiters;
      waiters = [];
      for (const wake of woken) wake();
    },
    pending() {
      return pending;
    },
    settled(timeoutMs = PENDING_GATE_TIMEOUT_MS) {
      if (!pending) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        let done = false;
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          // Drop the waiter so a later settle cannot resolve this promise a
          // second time.
          waiters = waiters.filter((waiter) => waiter !== wake);
          resolve(false);
        }, timeoutMs);
        const wake = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(true);
        };
        waiters.push(wake);
      });
    },
  };
}
