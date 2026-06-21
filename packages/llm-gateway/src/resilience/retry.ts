import { TimeoutError, defaultIsRetryable } from '../errors';

export type SleepFn = (ms: number) => Promise<void>;

export const realSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitter?: boolean;
  timeoutMs?: number;
  isRetryable?: (err: unknown) => boolean;
  sleep?: SleepFn;
  rand?: () => number;
  onRetry?: (info: { attempt: number; error: unknown; delayMs: number }) => void;
}

const DEFAULTS = {
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 8_000,
  jitter: true,
  timeoutMs: 120_000,
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
  const isRetryable = opts.isRetryable ?? defaultIsRetryable;
  const sleep = opts.sleep ?? realSleep;
  const rand = opts.rand ?? Math.random;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new TimeoutError(`attempt ${attempt} exceeded ${timeoutMs}ms`));
      }, timeoutMs);
    });

    try {
      return await Promise.race([fn(controller.signal), timeout]);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isRetryable(error)) throw error;
      const delayMs = backoffDelay(attempt, baseDelayMs, maxDelayMs, jitter, rand);
      opts.onRetry?.({ attempt, error, delayMs });
      await sleep(delayMs);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  throw lastError;
}
