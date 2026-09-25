import { TimeoutError } from '../errors';

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Per-attempt timeout — aborts a single attempt's signal. */
  timeoutMs?: number;
  /** Which failures are worth another attempt. The caller owns this policy. */
  isRetryable: (err: unknown) => boolean;
}

const DEFAULTS = {
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 8_000,
  // Per-attempt budget. On the STREAMING path this only bounds time-to-headers
  // (the transport returns as soon as the Response exists, so the race below
  // settles and the timer is cleared long before the body finishes). On the
  // NON-STREAMING path it bounds the whole completion — and 120s was far too
  // small for that: a Claude Fable 5 request emitting its 128,000-token ceiling
  // at 50 tok/s needs 2,560s (42m40s) before the single JSON body comes back.
  // 90 minutes clears that with room to spare and is never reached by a
  // healthy request, because a healthy request finishes when it finishes.
  timeoutMs: 90 * 60_000,
  // Total wall clock across all attempts. Kept above the per-attempt budget so
  // one full-length attempt can still be followed by a retry after a FAST
  // failure (a 500/timeout that returns in milliseconds), which is the only
  // case where retrying a request this long is useful. It caps the
  // pathological `maxAttempts × timeoutMs` blow-up where a stuck upstream keeps
  // the server busy for minutes after the client socket has closed.
  deadlineMs: 120 * 60_000,
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Exponential backoff with full-half jitter. */
function backoffDelay(attempt: number, baseMs: number, maxMs: number): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  return Math.floor(exponential / 2 + (exponential / 2) * Math.random());
}

export async function withRetry<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULTS.maxAttempts);
  const baseDelayMs = opts.baseDelayMs ?? DEFAULTS.baseDelayMs;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULTS.maxDelayMs;
  const timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs;
  const deadlineMs = DEFAULTS.deadlineMs;
  const isRetryable = opts.isRetryable;
  const now = Date.now;
  const start = now();

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Out of total budget — don't start another attempt.
    const remaining = deadlineMs - (now() - start);
    if (remaining <= 0) {
      if (lastError !== undefined) throw lastError;
      throw new TimeoutError(`request exceeded total deadline ${deadlineMs}ms`);
    }
    // The attempt's own timeout never outlives the total budget.
    const attemptTimeoutMs = Math.min(timeoutMs, remaining);

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new TimeoutError(`attempt ${attempt} exceeded ${attemptTimeoutMs}ms`));
      }, attemptTimeoutMs);
    });

    try {
      return await Promise.race([fn(controller.signal), timeout]);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isRetryable(error)) throw error;
      // Don't sleep past the deadline — and if no budget is left, stop now.
      const budgetLeft = deadlineMs - (now() - start);
      if (budgetLeft <= 0) throw error;
      const delayMs = Math.min(backoffDelay(attempt, baseDelayMs, maxDelayMs), budgetLeft);
      await sleep(delayMs);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  throw lastError;
}
