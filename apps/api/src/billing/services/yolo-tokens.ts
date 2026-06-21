// Billing v2 — per-member KORTIX YOLO tokens.
//
// One token per (user_id, account_id). Plaintext is generated at mint and
// returned to the caller exactly once; only a hash + a short prefix are
// persisted. The plaintext is kept in an in-process cache so sandbox bootstrap
// can read it without re-minting — but the cache is best-effort: a cache miss
// triggers a rotation (mint a fresh token, plaintext returned to the bootstrap
// flow, old hash revoked). This keeps the secret accessible without ever
// storing recoverable plaintext at rest.
//
// Spec ref: manager wants "PER MEMBER secret" injected into the sandbox so
// each member's YOLO usage is attributable. Token is what the kortix-agent-
// sandbox-server demon ships to the YOLO endpoint as Bearer auth.

import { createHash, randomBytes } from 'node:crypto';
import {
  revokeYoloToken,
} from '../repositories/yolo-tokens';

// In-process plaintext cache. Wiped on restart — bootstrap reissues on miss.
// Keyed by `${userId}::${accountId}`.
const plaintextCache = new Map<string, string>();

const TOKEN_BYTES = 32; // 256-bit secret
const PREFIX_LEN = 12;

function cacheKey(userId: string, accountId: string): string {
  return `${userId}::${accountId}`;
}

function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

function newPlaintext(): string {
  // Prefixed so logs that accidentally capture one are recognisable.
  return `kyolo_${randomBytes(TOKEN_BYTES).toString('base64url')}`;
}

/**
 * Mint a fresh token for a member. If a prior token row exists for this
 * (user, account) pair, the row is UPDATED in place with the new hash/prefix
 * and revoked_at is cleared. We can't insert a new row because the table has
 * PRIMARY KEY (user_id, account_id) — there's at most one row per pair, ever.
 *
 * Returns the plaintext — caller MUST inject it into the sandbox immediately;
 * subsequent fetches return cached plaintext, but the cache can be wiped at
 * any time by a server restart.
 */
export async function mintYoloTokenForMember(
  userId: string,
  accountId: string,
): Promise<string> {
  const plaintext = newPlaintext();
  const tokenPrefix = plaintext.slice(0, PREFIX_LEN);
  const tokenHash = hashToken(plaintext);

  const { db } = await import('../../shared/db');
  const { yoloMemberTokens } = await import('@kortix/db');
  await db
    .insert(yoloMemberTokens)
    .values({ userId, accountId, tokenPrefix, tokenHash })
    .onConflictDoUpdate({
      target: [yoloMemberTokens.userId, yoloMemberTokens.accountId],
      set: {
        tokenPrefix,
        tokenHash,
        createdAt: new Date().toISOString(),
        revokedAt: null,
        lastUsedAt: null,
      },
    });

  plaintextCache.set(cacheKey(userId, accountId), plaintext);
  return plaintext;
}

/**
 * Permanently revoke a member's YOLO token (member removed from account).
 * Idempotent.
 */
export async function revokeYoloTokenForMember(
  userId: string,
  accountId: string,
): Promise<void> {
  await revokeYoloToken(userId, accountId);
  plaintextCache.delete(cacheKey(userId, accountId));
}

/**
 * Lookup the (user, account) a sandbox-presented YOLO token belongs to.
 * Used by the YOLO usage attribution path on the API side.
 *
 * Match strategy: select all active rows with the matching prefix, compare
 * hashes. Prefix collisions are statistically impossible at 12 base64url chars
 * (~72 bits) but the loop is cheap if it ever happens.
 */
export async function attributeYoloToken(
  plaintext: string,
): Promise<{ userId: string; accountId: string } | null> {
  if (!plaintext.startsWith('kyolo_')) return null;
  const prefix = plaintext.slice(0, PREFIX_LEN);
  const hash = hashToken(plaintext);

  // Direct equality on prefix + hash. Drizzle inline for clarity.
  const { db } = await import('../../shared/db');
  const { yoloMemberTokens } = await import('@kortix/db');
  const { and, eq, isNull } = await import('drizzle-orm');

  const rows = await db
    .select({
      userId: yoloMemberTokens.userId,
      accountId: yoloMemberTokens.accountId,
      tokenHash: yoloMemberTokens.tokenHash,
    })
    .from(yoloMemberTokens)
    .where(
      and(
        eq(yoloMemberTokens.tokenPrefix, prefix),
        isNull(yoloMemberTokens.revokedAt),
      ),
    );

  for (const row of rows) {
    if (row.tokenHash === hash) {
      return { userId: row.userId, accountId: row.accountId };
    }
  }
  return null;
}
