/**
 * Bound a promise with a wall-clock timeout.
 *
 * Some upstream SDK calls (notably the Daytona SDK) take a request but expose
 * no per-call timeout / AbortSignal, so a degraded upstream can leave the
 * promise pending indefinitely. `Promise.race`-ing it against a timer turns an
 * unbounded hang into a deterministic, catchable failure — which the caller can
 * then degrade gracefully on instead of blocking a request forever.
 *
 * The losing branch (the slow promise) is left to settle in the background and
 * its result/rejection is intentionally ignored; the timer is always cleared so
 * a fast win doesn't keep the event loop alive.
 */

export class TimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number, label?: string) {
    super(
      label
        ? `${label} timed out after ${timeoutMs}ms`
        : `Operation timed out after ${timeoutMs}ms`,
    );
    this.name = 'TimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Resolve with `promise` if it settles within `timeoutMs`, otherwise reject
 * with a {@link TimeoutError}.
 *
 * @param promise   the work to bound
 * @param timeoutMs how long to wait before giving up (must be > 0)
 * @param label     optional context for the error message
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label?: string,
): Promise<T> {
  if (!(timeoutMs > 0)) {
    // A non-positive budget means "no bound" — just return the promise as-is
    // rather than rejecting immediately, so callers can disable the guard.
    return promise;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(timeoutMs, label)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}
