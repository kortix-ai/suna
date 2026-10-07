// The token-bucket limiter. The HTTP middleware that applies it to requests is
// `middleware/rate-limit.ts`.

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export interface RateLimitPolicy {
  limit: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetMs: number;
  retryAfterMs?: number;
}

// Hard cap on distinct live buckets per limiter. A limiter keyed on any
// attacker-influenced value (e.g. the public-session-share id) would otherwise
// grow this Map without bound under a flood of unique keys → process-wide OOM.
// When exceeded we evict the oldest-inserted entries (idle ones first).
const MAX_BUCKETS = 50_000;

export class TokenBucketRateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(private readonly namespace: string) {}

  private evictIfNeeded() {
    if (this.buckets.size < MAX_BUCKETS) return;
    // Map preserves insertion order and entries are refreshed in place (never
    // re-inserted), so the head is the least-recently-created. Drop ~10% to
    // amortize the sweep across many inserts.
    const dropCount = Math.ceil(MAX_BUCKETS * 0.1);
    let dropped = 0;
    for (const key of this.buckets.keys()) {
      this.buckets.delete(key);
      if (++dropped >= dropCount) break;
    }
  }

  check(key: string, policy: RateLimitPolicy): RateLimitResult {
    const limit = Math.max(1, Math.floor(policy.limit));
    const windowMs = Math.max(1000, Math.floor(policy.windowMs));
    const now = Date.now();
    const bucketKey = `${this.namespace}:${key}`;
    let bucket = this.buckets.get(bucketKey);

    if (!bucket) {
      this.evictIfNeeded();
      bucket = { tokens: limit - 1, lastRefill: now };
      this.buckets.set(bucketKey, bucket);
      return { allowed: true, limit, remaining: bucket.tokens, resetMs: windowMs };
    }

    const elapsed = now - bucket.lastRefill;
    const refill = Math.floor((elapsed / windowMs) * limit);
    if (refill > 0) {
      bucket.tokens = Math.min(limit, bucket.tokens + refill);
      bucket.lastRefill = now;
    }

    const resetMs = Math.max(windowMs - (now - bucket.lastRefill), 1000);
    if (bucket.tokens <= 0) {
      return {
        allowed: false,
        limit,
        remaining: 0,
        resetMs,
        retryAfterMs: resetMs,
      };
    }

    bucket.tokens -= 1;
    return { allowed: true, limit, remaining: bucket.tokens, resetMs };
  }

  reset() {
    this.buckets.clear();
  }
}
