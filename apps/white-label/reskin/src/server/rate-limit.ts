/**
 * In-memory token-bucket rate limiter, per authenticated `userId`. One bucket
 * per user, refilled continuously at `RATE_LIMIT_PER_MIN / 60_000` tokens/ms
 * so bursts smooth out instead of hard-resetting on a fixed window. Process-
 * local (same caveat as `server/users.ts`) — fine for this reference demo's
 * single-instance deployment.
 */

interface Bucket {
  tokens: number;
  updatedAt: number;
}

const buckets = new Map<string, Bucket>();

function capacity(): number {
  const n = Number(process.env.RATE_LIMIT_PER_MIN ?? 300);
  return Number.isFinite(n) && n > 0 ? n : 300;
}

export interface RateLimitResult {
  ok: boolean;
  /** Only set when `ok` is false — how long until the next token is available. */
  retryAfterMs?: number;
}

/** Consume one token for `userId`. Call once per proxied request. */
export function consumeRateLimit(userId: string): RateLimitResult {
  const cap = capacity();
  const refillPerMs = cap / 60_000;
  const now = Date.now();

  let bucket = buckets.get(userId);
  if (!bucket) {
    bucket = { tokens: cap, updatedAt: now };
    buckets.set(userId, bucket);
  }

  const elapsed = now - bucket.updatedAt;
  bucket.tokens = Math.min(cap, bucket.tokens + elapsed * refillPerMs);
  bucket.updatedAt = now;

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return { ok: true };
  }

  const deficit = 1 - bucket.tokens;
  return { ok: false, retryAfterMs: Math.max(1, Math.ceil(deficit / refillPerMs)) };
}
