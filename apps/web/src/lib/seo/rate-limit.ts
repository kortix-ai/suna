const WINDOW_MS = 60_000;
export const AI_INDEX_RATE_LIMIT = 120;
/** Hard ceiling on live buckets; the oldest bucket goes first. */
const MAX_BUCKETS = 10_000;

type Bucket = { count: number; resetsAt: number };
const buckets = new Map<string, Bucket>();

export type RateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetsAt: number;
};

/**
 * The caller's address as the nearest proxy saw it. `x-real-ip` is set by the
 * edge. The LAST `x-forwarded-for` entry is the one our own proxy appended; the
 * first is whatever the client sent, so rotating it must not mint new buckets.
 */
export function clientIp(request: Request): string {
  const real = request.headers.get('x-real-ip')?.trim();
  if (real) return real;
  const forwarded = request.headers.get('x-forwarded-for')?.split(',');
  return forwarded?.[forwarded.length - 1]?.trim() || 'anonymous';
}

export function consumeRateLimit(
  key: string,
  limit: number,
  now = Date.now(),
): RateLimitResult {
  const current = buckets.get(key);
  const bucket =
    !current || current.resetsAt <= now ? { count: 0, resetsAt: now + WINDOW_MS } : current;
  bucket.count += 1;
  buckets.set(key, bucket);

  // Keep the best-effort in-process limiter bounded in long-lived runtimes:
  // drop expired buckets, then the oldest until under the ceiling.
  if (buckets.size > MAX_BUCKETS) {
    for (const [bucketKey, value] of buckets) {
      if (value.resetsAt <= now) buckets.delete(bucketKey);
    }
    for (const bucketKey of buckets.keys()) {
      if (buckets.size <= MAX_BUCKETS) break;
      buckets.delete(bucketKey);
    }
  }

  return {
    allowed: bucket.count <= limit,
    limit,
    remaining: Math.max(0, limit - bucket.count),
    resetsAt: bucket.resetsAt,
  };
}

export function consumeAiIndexRateLimit(key: string, now = Date.now()): RateLimitResult {
  return consumeRateLimit(`ai:${key}`, AI_INDEX_RATE_LIMIT, now);
}

export function resetAiIndexRateLimitsForTests(): void {
  buckets.clear();
}
