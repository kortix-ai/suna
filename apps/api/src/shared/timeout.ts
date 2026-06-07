/**
 * Tiny, dependency-free promise-timeout helpers.
 *
 * Several hot paths await an unbounded I/O call (a provider SDK round-trip, a
 * provider state lookup on a polling endpoint, …). If the remote side stalls,
 * the await hangs forever and the latency propagates all the way up to the
 * browser, which aborts at its own client timeout and reports a Sentry error.
 * These helpers bound the *wait* (the underlying work is not cancelled — most
 * SDK calls don't expose an abort signal — but we stop blocking on it), turning
 * an indefinite hang into a fast, recoverable failure.
 */

/** Sentinel that {@link withTimeout} rejects with, so callers can tell a
 * deadline miss apart from a genuine error from the wrapped promise. */
export const TIMEOUT_SENTINEL: unique symbol = Symbol('promise-timeout');

/**
 * Resolve `promise`, or reject with {@link TIMEOUT_SENTINEL} if it has not
 * settled within `ms`. The timer is always cleared (`finally`) so we never leak
 * a handle or keep the event loop alive after the race settles.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(TIMEOUT_SENTINEL), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

/**
 * Like {@link withTimeout} but rejects with a descriptive `Error` (carrying
 * `label`) instead of the sentinel — handier when the timeout is logged or the
 * caller just falls back on any failure.
 */
export function withDeadline<T>(promise: Promise<T>, ms: number, label = 'operation'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}
