import { TimeoutError } from '../errors';

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Per-attempt timeout — aborts a single attempt's signal. */
  timeoutMs: number;
  /** Which failures are worth another attempt. The caller owns this policy. */
  isRetryable: (err: unknown) => boolean;
}

// Total wall clock across all attempts. It caps the pathological
// `maxAttempts × timeoutMs` blow-up where a stuck upstream keeps the server
// busy after the client socket has closed.
const DEADLINE_MS = 120 * 60_000;

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
  const maxAttempts = Math.max(1, opts.maxAttempts);
  const { baseDelayMs, maxDelayMs, timeoutMs, isRetryable } = opts;
  const deadlineMs = DEADLINE_MS;
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
