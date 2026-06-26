import { TimeoutError, defaultIsRetryable } from '../errors';

export type SleepFn = (ms: number) => Promise<void>;

export const realSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitter?: boolean;
  /** Per-attempt timeout — aborts a single attempt's signal. */
  timeoutMs?: number;
  /**
   * Total wall-clock budget across ALL attempts (including backoff sleeps). Caps
   * the pathological `maxAttempts × timeoutMs` blow-up where a stuck upstream
   * keeps the server busy for minutes after the client socket has closed.
   */
  deadlineMs?: number;
  isRetryable?: (err: unknown) => boolean;
  sleep?: SleepFn;
  rand?: () => number;
  /** Injectable clock for the deadline (defaults to Date.now). */
  now?: () => number;
  onRetry?: (info: { attempt: number; error: unknown; delayMs: number }) => void;
}

const DEFAULTS = {
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 8_000,
  jitter: true,
  timeoutMs: 120_000,
  // ~2 attempts' worth — bounds total server time well under the old
  // 3 × 120s = 6-minute worst case while leaving slow single attempts alone.
  deadlineMs: 240_000,
};

export function backoffDelay(
  attempt: number,
  baseMs: number,
  maxMs: number,
  jitter: boolean,
  rand: () => number,
): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  if (!jitter) return exponential;
  return Math.floor(exponential / 2 + (exponential / 2) * rand());
}

export async function withRetry<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULTS.maxAttempts);
  const baseDelayMs = opts.baseDelayMs ?? DEFAULTS.baseDelayMs;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULTS.maxDelayMs;
  const jitter = opts.jitter ?? DEFAULTS.jitter;
  const timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs;
  const deadlineMs = opts.deadlineMs ?? DEFAULTS.deadlineMs;
  const isRetryable = opts.isRetryable ?? defaultIsRetryable;
  const sleep = opts.sleep ?? realSleep;
  const rand = opts.rand ?? Math.random;
  const now = opts.now ?? Date.now;
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
      const delayMs = Math.min(backoffDelay(attempt, baseDelayMs, maxDelayMs, jitter, rand), budgetLeft);
      opts.onRetry?.({ attempt, error, delayMs });
      await sleep(delayMs);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  throw lastError;
}
