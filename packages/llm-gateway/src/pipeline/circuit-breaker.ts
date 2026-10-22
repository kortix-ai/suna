import { createHash } from 'node:crypto';
import type { UpstreamDescriptor } from '../domain';

/**
 * Per-upstream circuit breaker. An upstream (provider + base URL + model +
 * credential) that keeps failing is skipped for a cooldown, so requests go
 * straight to the next candidate or fallback model instead of paying a failed
 * attempt each. After the cooldown exactly one request probes it (half-open):
 * success closes the circuit, failure re-opens it with a doubled cooldown.
 *
 * Only failures that say "this upstream cannot serve now" count: a network
 * error or timeout, 408, 409, 425, 429 and any 5xx. A request error (400, 413,
 * 422) or a credential/permission error (401, 403, 404) belongs to the request
 * or the key owner and never trips it.
 *
 * State is per gateway process (in memory). With several gateway tasks each
 * learns on its own; a failing upstream is still skipped after a handful of
 * requests per task.
 */

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface BreakerOptions {
  /** Consecutive failures that open the circuit. */
  consecutiveFailures: number;
  /** Failure share in the window that opens it, once `minRequests` were seen. */
  failureRatio: number;
  minRequests: number;
  windowMs: number;
  /** First cooldown; doubles on every re-open up to `maxCooldownMs`. */
  cooldownMs: number;
  maxCooldownMs: number;
  now: () => number;
}

export const DEFAULT_BREAKER_OPTIONS: BreakerOptions = {
  consecutiveFailures: 5,
  failureRatio: 0.5,
  minRequests: 10,
  windowMs: 30_000,
  cooldownMs: 30_000,
  maxCooldownMs: 300_000,
  now: () => Date.now(),
};

interface Circuit {
  state: CircuitState;
  consecutive: number;
  /** Outcomes in the window: [timestamp, failed]. */
  window: Array<[number, boolean]>;
  openedAt: number;
  cooldownMs: number;
  probing: boolean;
  lastReason?: string;
  provider: string;
  model: string;
  publicListing: boolean;
}

/** Whether a failed attempt with this status says the upstream cannot serve now. */
export function tripsBreaker(status: number | undefined): boolean {
  if (status === undefined) return true;
  return status >= 500 || status === 408 || status === 409 || status === 425 || status === 429;
}

export function breakerKey(descriptor: UpstreamDescriptor, model: string): string {
  const credential = descriptor.poolSecretId ?? descriptor.credentialRef
    ?? (descriptor.apiKey ? createHash('sha256').update(descriptor.apiKey).digest('hex').slice(0, 16) : '');
  return [descriptor.provider, descriptor.baseUrl ?? '', descriptor.resolvedModel ?? model, credential].join('|');
}

export class CircuitBreakers {
  private readonly circuits = new Map<string, Circuit>();
  private readonly opts: BreakerOptions;

  constructor(opts: Partial<BreakerOptions> = {}) {
    this.opts = { ...DEFAULT_BREAKER_OPTIONS, ...opts };
  }

  /**
   * Whether this attempt may reach the upstream now. An open circuit whose
   * cooldown has passed lets exactly one caller through as the probe.
   */
  allow(key: string): boolean {
    const circuit = this.circuits.get(key);
    if (!circuit || circuit.state === 'closed') return true;
    if (circuit.state === 'open' && this.opts.now() - circuit.openedAt >= circuit.cooldownMs) {
      circuit.state = 'half_open';
      circuit.probing = false;
    }
    if (circuit.state === 'half_open' && !circuit.probing) {
      circuit.probing = true;
      return true;
    }
    return false;
  }

  success(key: string): void {
    const circuit = this.circuits.get(key);
    if (!circuit) return;
    if (circuit.state !== 'closed') {
      circuit.state = 'closed';
      circuit.cooldownMs = this.opts.cooldownMs;
      circuit.probing = false;
    }
    circuit.consecutive = 0;
    this.record(circuit, false);
  }

  failure(key: string, meta: { provider: string; model: string; reason: string; publicListing: boolean }): CircuitState {
    const now = this.opts.now();
    let circuit = this.circuits.get(key);
    if (!circuit) {
      circuit = {
        state: 'closed', consecutive: 0, window: [], openedAt: 0, cooldownMs: this.opts.cooldownMs, probing: false,
        provider: meta.provider, model: meta.model, publicListing: meta.publicListing,
      };
      this.circuits.set(key, circuit);
    }
    circuit.lastReason = meta.reason;
    circuit.consecutive += 1;
    this.record(circuit, true);
    if (circuit.state === 'half_open') {
      circuit.cooldownMs = Math.min(circuit.cooldownMs * 2, this.opts.maxCooldownMs);
      this.open(circuit, now);
      return circuit.state;
    }
    if (circuit.state === 'closed') {
      const failed = circuit.window.filter(([, f]) => f).length;
      const ratioTripped = circuit.window.length >= this.opts.minRequests
        && failed / circuit.window.length >= this.opts.failureRatio;
      if (circuit.consecutive >= this.opts.consecutiveFailures || ratioTripped) this.open(circuit, now);
    }
    return circuit.state;
  }

  state(key: string): CircuitState {
    return this.circuits.get(key)?.state ?? 'closed';
  }

  /** Circuits that are not closed. `publicOnly` keeps credential-owned (BYOK) circuits out. */
  snapshot(publicOnly = false): Array<{ provider: string; model: string; state: CircuitState; since: string; cooldownMs: number; lastReason?: string }> {
    const out = [];
    for (const circuit of this.circuits.values()) {
      if (circuit.state === 'closed' || (publicOnly && !circuit.publicListing)) continue;
      out.push({
        provider: circuit.provider, model: circuit.model, state: circuit.state,
        since: new Date(circuit.openedAt).toISOString(), cooldownMs: circuit.cooldownMs, lastReason: circuit.lastReason,
      });
    }
    return out;
  }

  private open(circuit: Circuit, now: number): void {
    circuit.state = 'open';
    circuit.openedAt = now;
    circuit.probing = false;
  }

  private record(circuit: Circuit, failed: boolean): void {
    const now = this.opts.now();
    circuit.window.push([now, failed]);
    const cutoff = now - this.opts.windowMs;
    while (circuit.window.length && circuit.window[0]![0] < cutoff) circuit.window.shift();
  }
}

/** The gateway process's breakers. replica-local: each gateway task learns on its own. */
export const upstreamBreakers = new CircuitBreakers();
