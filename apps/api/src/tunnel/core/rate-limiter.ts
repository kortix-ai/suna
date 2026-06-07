import { config } from '../../config';
import { TunnelErrorCode } from 'agent-tunnel';

interface Bucket {
  tokens: number;
  lastRefill: number;
}

interface RateLimitConfig {
  limit: number;
  windowMs: number;
}

class TunnelRateLimiter {
  private buckets = new Map<string, Bucket>();

  private configs: Record<string, RateLimitConfig> = {
    rpc: { limit: config.TUNNEL_RATE_LIMIT_RPC, windowMs: 60_000 },
    permRequest: { limit: config.TUNNEL_RATE_LIMIT_PERM_REQUEST, windowMs: 60_000 },
    wsConnect: { limit: config.TUNNEL_RATE_LIMIT_WS_CONNECT, windowMs: 60_000 },
    permGrant: { limit: config.TUNNEL_RATE_LIMIT_PERM_GRANT, windowMs: 60_000 },
    deviceAuthCreateGlobal: { limit: 100, windowMs: 60_000 },
    deviceAuthCreate: { limit: 5, windowMs: 60_000 },
    deviceAuthPoll: { limit: 30, windowMs: 60_000 },
  };

  check(endpoint: string, key: string): { allowed: boolean; retryAfterMs?: number } {
    const cfg = this.configs[endpoint];
    if (!cfg) return { allowed: true };

    const bucketKey = `${endpoint}:${key}`;
    return this.checkAndConsume(bucketKey, cfg.limit, cfg.windowMs);
  }

  private checkAndConsume(
    key: string,
    limit: number,
    windowMs: number,
  ): { allowed: boolean; retryAfterMs?: number } {
    const now = Date.now();
    let bucket = this.buckets.get(key);

    if (!bucket) {
      bucket = { tokens: limit - 1, lastRefill: now };
      this.buckets.set(key, bucket);
      return { allowed: true };
    }

    const elapsed = now - bucket.lastRefill;
    const refill = Math.floor((elapsed / windowMs) * limit);
    if (refill > 0) {
      bucket.tokens = Math.min(limit, bucket.tokens + refill);
      bucket.lastRefill = now;
    }

    if (bucket.tokens <= 0) {
      const retryAfterMs = windowMs - elapsed;
      return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 1000) };
    }

    bucket.tokens--;
    return { allowed: true };
  }

  cleanup(): void {
    const now = Date.now();
    const maxAge = 120_000;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastRefill > maxAge) {
        this.buckets.delete(key);
      }
    }
  }
}

export const tunnelRateLimiter = new TunnelRateLimiter();
