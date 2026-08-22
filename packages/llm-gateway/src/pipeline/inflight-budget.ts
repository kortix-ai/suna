/**
 * Admission control: the difference between "degrades loudly" and "dies".
 *
 * Bounding ONE request's memory is not enough. With a per-request ceiling of
 * 128 MiB and no limit on how many run at once, twenty concurrent image-heavy
 * turns still exhaust the process — memory is bounded per request and unbounded
 * in aggregate, so the crash simply arrives later. That is what killed the dev
 * API on 2026-08-21 (`exit 137`, three times in eleven minutes).
 *
 * So the process tracks how many bytes are in flight and REFUSES work it cannot
 * hold. Three properties follow, and they are the whole point:
 *
 *   1. Work beyond the configured memory envelope is declined before its body
 *      is retained. A declined request costs one request. An OOM costs every
 *      request in flight and restarts the container.
 *
 *   2. IT FAILS LOUDLY AND SPECIFICALLY. `too_large` (413) means the body could
 *      never fit and retrying is pointless. `overloaded` (503 + Retry-After)
 *      means it would fit if the gateway were quieter, so retrying is exactly
 *      right. Collapsing those into one error would send half the callers into
 *      a useless retry loop.
 *
 *   3. IT KEEPS SCALING. A 503 is a pressure signal the load balancer and the
 *      autoscaler can both see and act on. An OOM is a silent disappearance
 *      that looks, to every metric that drives scaling, like a task that simply
 *      stopped existing. Shedding load is what lets the fleet grow into it.
 */

export interface InflightBudgetOptions {
  /** Total bytes (after amplification) the process will hold at once. 0 disables. */
  maxBytes: number;
  /** Largest single request admitted, in wire bytes. */
  perRequestMaxBytes: number;
  /**
   * How much memory one wire byte really costs once it is a UTF-16 string plus
   * a `JSON.parse` object graph. A budget counting raw wire bytes would admit
   * roughly this many times more than the process can hold.
   */
  amplification?: number;
}

export type InflightLease =
  | {
      ok: true;
      release: () => void;
      resize: (wireBytes: number) => InflightResizeResult;
    }
  | { ok: false; reason: 'too_large' | 'overloaded'; retryAfterSeconds?: number };

export type InflightResizeResult =
  | { ok: true }
  | { ok: false; reason: 'too_large' | 'overloaded' };

/**
 * Measured against the shapes this pipeline actually builds: the raw body as a
 * UTF-16 string (~2x for JSON, which is overwhelmingly ASCII), plus the parsed
 * object graph. Three is deliberately conservative — being wrong here in the
 * generous direction costs throughput; being wrong in the other direction costs
 * the container.
 */
export const DEFAULT_BODY_AMPLIFICATION = 3;

export class InflightBudget {
  private readonly maxBytes: number;
  private readonly perRequestMaxBytes: number;
  private readonly amplification: number;
  private current = 0;

  constructor(options: InflightBudgetOptions) {
    this.maxBytes = Math.max(0, Math.trunc(options.maxBytes));
    this.perRequestMaxBytes = Math.max(0, Math.trunc(options.perRequestMaxBytes));
    this.amplification = options.amplification ?? DEFAULT_BODY_AMPLIFICATION;
  }

  /** Bytes currently reserved, after amplification. */
  get inflightBytes(): number {
    return this.current;
  }

  get capacityBytes(): number {
    return this.maxBytes;
  }

  /** 0..1 — for logging, and for a metric worth alarming on. */
  get utilisation(): number {
    return this.maxBytes > 0 ? this.current / this.maxBytes : 0;
  }

  /**
   * Reserve capacity for a request of `wireBytes`, or explain why not.
   *
   * The ordering matters: "is this request admissible AT ALL" is answered before
   * "is there room right now", so a body that can never fit is told the truth
   * (413) instead of being invited to retry forever against a 503.
   */
  admit(wireBytes: number): InflightLease {
    if (this.maxBytes <= 0) {
      return { ok: true, release: () => {}, resize: () => ({ ok: true }) };
    }

    let cost = Math.max(0, Math.trunc(wireBytes)) * this.amplification;

    // Never-fits: terminal, and honest about it.
    if (this.perRequestMaxBytes > 0 && wireBytes > this.perRequestMaxBytes) {
      return { ok: false, reason: 'too_large' };
    }
    if (cost > this.maxBytes) {
      return { ok: false, reason: 'too_large' };
    }

    // Fits in principle, but not right now.
    if (this.current + cost > this.maxBytes) {
      return { ok: false, reason: 'overloaded', retryAfterSeconds: 1 };
    }

    this.current += cost;
    let released = false;
    return {
      ok: true,
      resize: (nextWireBytes: number): InflightResizeResult => {
        if (released) return { ok: false, reason: 'overloaded' };
        const normalized = Math.max(0, Math.trunc(nextWireBytes));
        const nextCost = normalized * this.amplification;
        if (
          (this.perRequestMaxBytes > 0 && normalized > this.perRequestMaxBytes) ||
          nextCost > this.maxBytes
        ) {
          return { ok: false, reason: 'too_large' };
        }
        if (this.current - cost + nextCost > this.maxBytes) {
          return { ok: false, reason: 'overloaded' };
        }
        this.current = Math.max(0, this.current - cost + nextCost);
        cost = nextCost;
        return { ok: true };
      },
      // Idempotent: a handler with both an explicit release and a `finally`
      // must not be able to hand back the same bytes twice and inflate the
      // budget past what the process actually has.
      release: () => {
        if (released) return;
        released = true;
        this.current = Math.max(0, this.current - cost);
      },
    };
  }
}
