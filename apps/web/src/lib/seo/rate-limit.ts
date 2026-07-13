const WINDOW_MS = 60_000;
export const AI_INDEX_RATE_LIMIT = 120;

type Bucket = { count: number; resetsAt: number };
const buckets = new Map<string, Bucket>();

export type RateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetsAt: number;
};

export function consumeAiIndexRateLimit(key: string, now = Date.now()): RateLimitResult {
  const current = buckets.get(key);
  const bucket =
    !current || current.resetsAt <= now ? { count: 0, resetsAt: now + WINDOW_MS } : current;
  bucket.count += 1;
  buckets.set(key, bucket);

  // Keep the best-effort in-process limiter bounded in long-lived runtimes.
  if (buckets.size > 10_000) {
    for (const [bucketKey, value] of buckets) {
      if (value.resetsAt <= now) buckets.delete(bucketKey);
    }
  }

  return {
    allowed: bucket.count <= AI_INDEX_RATE_LIMIT,
    limit: AI_INDEX_RATE_LIMIT,
    remaining: Math.max(0, AI_INDEX_RATE_LIMIT - bucket.count),
    resetsAt: bucket.resetsAt,
  };
}

export function resetAiIndexRateLimitsForTests(): void {
  buckets.clear();
}
