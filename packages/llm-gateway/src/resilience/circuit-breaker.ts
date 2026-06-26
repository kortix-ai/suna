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

/**
 * A read-only, fleet-wide breaker signal injected by the host. The in-memory
 * breaker is per-process, so a burst seen on ONE API replica only opens that
 * replica's breaker — siblings keep hammering a down provider. This lets the host
 * surface a SHARED open verdict (aggregated from a store like Postgres) that any
 * replica's breaker adopts, so a tripped provider fails over fleet-wide.
 *
 * It is consulted synchronously on the hot path, so the host must serve a cached
 * snapshot (refresh on a short timer) — never a live query per request.
 */
export interface BreakerSignalStore {
  /** Is this provider currently tripped open across the fleet (cached snapshot)? */
  isOpenFleetWide(provider: string): boolean;
}

export class CircuitBreaker {
  private state: BreakerState = 'closed';
  private failureTimes: number[] = [];
  private openedAt = 0;
  // A single in-flight half-open probe per process. Without this, every concurrent
  // caller in the half-open window is admitted and they all hammer a still-down
  // provider at once. Per-process (documented limitation: each replica admits one
  // probe, so the fleet sends up to N probes — still far fewer than unbounded).
  private probeInFlight = false;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly provider?: string;
  private readonly signal?: BreakerSignalStore;

  constructor(opts: CircuitBreakerOptions = {}, provider?: string, signal?: BreakerSignalStore) {
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.cooldownMs = opts.cooldownMs ?? 30_000;
    this.windowMs = opts.windowMs ?? 60_000;
    this.now = opts.now ?? Date.now;
    this.provider = provider;
    this.signal = signal;
  }

  private prune(t: number): void {
    const cutoff = t - this.windowMs;
    if (this.failureTimes.length && this.failureTimes[0] < cutoff) {
      this.failureTimes = this.failureTimes.filter((ts) => ts >= cutoff);
    }
  }

  canRequest(): boolean {
    // Fleet-wide signal: a sibling replica already tripped this provider open in
    // the shared store. Adopt it locally (idempotent — only when currently closed)
    // so the SAME open → cooldown → single-probe machinery below governs both the
    // locally-observed and the fleet-observed open. No parallel code path.
    if (
      this.state === 'closed' &&
      this.provider !== undefined &&
      this.signal?.isOpenFleetWide(this.provider) === true
    ) {
      this.state = 'open';
      this.openedAt = this.now();
    }

    if (this.state === 'closed') return true;

    if (this.state === 'open') {
      if (this.now() - this.openedAt < this.cooldownMs) return false;
      // Cooldown elapsed → move to half-open and let exactly one probe through.
      this.state = 'half-open';
    }
    // half-open: admit a single in-flight probe.
    if (this.probeInFlight) return false;
    this.probeInFlight = true;
    return true;
  }

  onSuccess(): void {
    this.failureTimes = [];
    this.state = 'closed';
    this.probeInFlight = false;
  }

  onFailure(): void {
    const t = this.now();
    // A failure while probing (half-open) re-opens immediately.
    if (this.state === 'half-open') {
      this.state = 'open';
      this.openedAt = t;
      this.failureTimes = [t];
      this.probeInFlight = false;
      return;
    }
    this.failureTimes.push(t);
    this.prune(t);
    if (this.failureTimes.length >= this.failureThreshold) {
      this.state = 'open';
      this.openedAt = t;
    }
  }

  /**
   * Release a half-open probe slot WITHOUT changing the open/closed verdict. Used
   * when a probe returned a reachable-but-rejected answer (4xx/429/402) — the host
   * is up (so don't trip the breaker) but the probe is done (so free the slot for
   * the next one). A no-op in the closed state, so it never disturbs failure
   * accounting there.
   */
  onProbeReleased(): void {
    this.probeInFlight = false;
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
    if (indicatesUpstreamDown(error)) {
      binding?.breaker.onFailure();
    } else {
      // A reachable-but-rejected answer (4xx/429/402): the host is up, so don't
      // trip the breaker — but if this call held the half-open probe slot, free
      // it so the breaker isn't left stuck rejecting every subsequent probe.
      binding?.breaker.onProbeReleased();
    }
    throw error;
  }
}
