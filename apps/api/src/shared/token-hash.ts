import { createHmac, scrypt } from 'node:crypto';
import { config } from '../config';

/**
 * Lookup hashes for a PRESENTED Kortix token, computed off the event loop and
 * remembered.
 *
 * `hashSecretKey` (shared/crypto.ts) is `scryptSync`: 30-100 ms of CPU on the
 * one event-loop thread for every validation. Any caller could send
 * `Authorization: Bearer kortix_pat_<random>` and pay for that with nothing.
 * This module is the validation path:
 *
 *  - `crypto.scrypt` runs on the libuv thread pool, so a validation no longer
 *    blocks every other request on the replica;
 *  - the result is remembered in two bounded LRU maps. A token that matched a
 *    row (`markTokenValidated`) lives in the POSITIVE map; every other token
 *    lives in the NEGATIVE map with a shorter lifetime. Unknown tokens can
 *    therefore never evict the tokens of real callers.
 *
 * Only the HASH is remembered, never the validation verdict. Every call still
 * reads the token row, so a revoked or expired token stops working on its next
 * request exactly as before.
 *
 * The stored format is unchanged: `scrypt:v1:<hex>` with the same parameters
 * (N=16384, r=8, p=1, 32 bytes) as `hashSecretKey`, plus the legacy
 * HMAC-SHA256 digest for rows written before scrypt.
 */

const POSITIVE_TTL_MS = 10 * 60_000;
const NEGATIVE_TTL_MS = 2 * 60_000;
const MAX_ENTRIES = 10_000;

type Entry = { hashes: readonly string[]; expiresAt: number };

class BoundedLru {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
  ) {}

  get(key: string, now: number): readonly string[] | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return null;
    }
    // Refresh recency: Map iteration order is insertion order.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.hashes;
  }

  set(key: string, hashes: readonly string[], now: number): void {
    this.entries.delete(key);
    this.entries.set(key, { hashes, expiresAt: now + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}

let positive = new BoundedLru(MAX_ENTRIES, POSITIVE_TTL_MS);
let negative = new BoundedLru(MAX_ENTRIES, NEGATIVE_TTL_MS);
const inflight = new Map<string, Promise<readonly string[]>>();

function pepper(): string {
  const secret = config.API_KEY_SECRET;
  if (!secret) throw new Error('API_KEY_SECRET not configured');
  return secret;
}

/** The legacy HMAC digest. It doubles as the cache key: no plaintext is kept. */
function legacyDigest(secretKey: string, secret: string): string {
  return createHmac('sha256', secret).update(secretKey).digest('hex');
}

function scryptHash(secretKey: string, secret: string): Promise<string> {
  return new Promise((resolve, reject) => {
    scrypt(secretKey, secret, 32, (err, derived) => {
      if (err) reject(err);
      else resolve(`scrypt:v1:${derived.toString('hex')}`);
    });
  });
}

/**
 * `[scrypt hash, legacy HMAC digest]` for a presented token — the same pair
 * `candidateSecretKeyHashes` returns, without blocking the event loop.
 */
export async function candidateSecretKeyHashesAsync(secretKey: string): Promise<string[]> {
  const secret = pepper();
  const key = legacyDigest(secretKey, secret);
  const now = Date.now();
  const cached = positive.get(key, now) ?? negative.get(key, now);
  if (cached) return [...cached];

  let pending = inflight.get(key);
  if (!pending) {
    pending = scryptHash(secretKey, secret).then((hash) => {
      const hashes = [hash, key] as const;
      negative.set(key, hashes, Date.now());
      return hashes;
    });
    inflight.set(key, pending);
    pending.finally(() => inflight.delete(key)).catch(() => {});
  }
  return [...(await pending)];
}

/** The scrypt lookup hash alone, for tables that store only that form. */
export async function hashSecretKeyAsync(secretKey: string): Promise<string> {
  const [hash] = await candidateSecretKeyHashesAsync(secretKey);
  return hash!;
}

/**
 * Move a token that matched a live row to the positive map, so a flood of
 * unknown tokens cannot evict it. Call only after the row lookup succeeded.
 */
export function markTokenValidated(secretKey: string): void {
  const secret = config.API_KEY_SECRET;
  if (!secret) return;
  const key = legacyDigest(secretKey, secret);
  const now = Date.now();
  const hashes = negative.get(key, now) ?? positive.get(key, now);
  if (!hashes) return;
  negative.delete(key);
  positive.set(key, hashes, now);
}

/** True when validating this token needs no new scrypt computation. */
export function isTokenHashCached(secretKey: string): boolean {
  const secret = config.API_KEY_SECRET;
  if (!secret) return false;
  const key = legacyDigest(secretKey, secret);
  const now = Date.now();
  return positive.get(key, now) !== null || negative.get(key, now) !== null;
}

/** True when this token matched a live row recently on this process. */
export function isTokenValidated(secretKey: string): boolean {
  const secret = config.API_KEY_SECRET;
  if (!secret) return false;
  return positive.get(legacyDigest(secretKey, secret), Date.now()) !== null;
}

/** Test seam. `maxEntries` rebuilds both maps with a smaller bound. */
export function resetTokenHashCache(maxEntries: number = MAX_ENTRIES): void {
  positive = new BoundedLru(maxEntries, POSITIVE_TTL_MS);
  negative = new BoundedLru(maxEntries, NEGATIVE_TTL_MS);
  inflight.clear();
}

/** Test seam: entry counts per map. */
export function tokenHashCacheSizes(): { positive: number; negative: number } {
  return { positive: positive.size, negative: negative.size };
}
