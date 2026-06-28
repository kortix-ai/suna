import { CircuitOpenError, indicatesUpstreamDown } from '../errors';
import { type RetryOptions, withRetry } from './retry';

export type BreakerState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  cooldownMs?: number;
  /**
   * Rolling window for counting failures. Failures older than this age out, so a
   * slow drip of errors over hours never trips the breaker — only a genuine
   * burst (`failureThreshold` within `windowMs`) does.
   */
  windowMs?: number;
  now?: () => number;
}

export class CircuitBreaker {
  private state: BreakerState = 'closed';
  private failureTimes: number[] = [];
  private openedAt = 0;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.cooldownMs = opts.cooldownMs ?? 30_000;
    this.windowMs = opts.windowMs ?? 60_000;
    this.now = opts.now ?? Date.now;
  }

  private prune(t: number): void {
    const cutoff = t - this.windowMs;
    if (this.failureTimes.length && this.failureTimes[0] < cutoff) {
      this.failureTimes = this.failureTimes.filter((ts) => ts >= cutoff);
    }
  }

  canRequest(): boolean {
    if (this.state !== 'open') return true;
    if (this.now() - this.openedAt >= this.cooldownMs) {
      this.state = 'half-open';
      return true;
    }
    return false;
  }

  onSuccess(): void {
    this.failureTimes = [];
    this.state = 'closed';
  }

  onFailure(): void {
    const t = this.now();
    // A failure while probing (half-open) re-opens immediately.
    if (this.state === 'half-open') {
      this.state = 'open';
      this.openedAt = t;
      this.failureTimes = [t];
      return;
    }
    this.failureTimes.push(t);
    this.prune(t);
    if (this.failureTimes.length >= this.failureThreshold) {
      this.state = 'open';
      this.openedAt = t;
    }
  }

  get current(): BreakerState {
    return this.state;
  }

  get failureCount(): number {
    return this.failureTimes.length;
  }
}

export interface BreakerBinding {
  provider: string;
  breaker: CircuitBreaker;
}

export async function withResilience<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  opts: RetryOptions,
  binding?: BreakerBinding,
): Promise<T> {
  if (binding && !binding.breaker.canRequest()) {
    throw new CircuitOpenError(binding.provider);
  }
  try {
    const result = await withRetry(fn, opts);
    binding?.breaker.onSuccess();
    return result;
  } catch (error) {
    // Only genuine upstream-down signals (5xx/network/timeout) trip the shared
    // provider breaker — never a 429/402/403, which is this caller's quota, not
    // the host being unhealthy. See indicatesUpstreamDown.
    if (indicatesUpstreamDown(error)) binding?.breaker.onFailure();
    throw error;
  }
}
