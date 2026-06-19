import { CircuitOpenError } from '../errors';
import { withRetry, type RetryOptions } from './retry';

export type BreakerState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  cooldownMs?: number;
  now?: () => number;
}

export class CircuitBreaker {
  private state: BreakerState = 'closed';
  private failures = 0;
  private openedAt = 0;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.cooldownMs = opts.cooldownMs ?? 30_000;
    this.now = opts.now ?? Date.now;
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
    this.failures = 0;
    this.state = 'closed';
  }

  onFailure(): void {
    this.failures += 1;
    if (this.state === 'half-open' || this.failures >= this.failureThreshold) {
      this.state = 'open';
      this.openedAt = this.now();
    }
  }

  get current(): BreakerState {
    return this.state;
  }

  get failureCount(): number {
    return this.failures;
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
    binding?.breaker.onFailure();
    throw error;
  }
}
