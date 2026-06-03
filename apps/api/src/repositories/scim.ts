// Data layer for SCIM 2.0. Two responsibilities:
//   1. SCIM bearer token lifecycle (mint, validate, list, revoke).
//   2. Looking up + writing the SCIM-side mutations (users, groups, members).
//
// The actual SCIM protocol mapping (request shapes, error envelopes) lives
// in the route handler — this file is plain Drizzle.

import { createHash, randomInt } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { scimTokens } from '@kortix/db';
import { db } from '../shared/db';

const SCIM_TOKEN_PREFIX = 'kortix_scim_';
const SCIM_TOKEN_BODY_LEN = 40; // base32-ish alphanumeric, ~200 bits of entropy

// ─── Token mint + validate ─────────────────────────────────────────────────

function randomAlphanum(len: number): string {
  // Avoid 0/O/1/I to keep tokens human-recognisable; matches what most
  // SaaS API key generators do. `crypto.randomInt` is unbiased (Node
  // does the rejection sampling internally), so we sidestep the modulo
  // bias that `randomBytes(...) % N` would have when N doesn't divide 256.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[randomInt(alphabet.length)]!;
  return out;
}

function generateScimSecret(): string {
  return `${SCIM_TOKEN_PREFIX}${randomAlphanum(SCIM_TOKEN_BODY_LEN)}`;
}

function hashScimSecret(plaintext: string): string {
  // SHA-256 hex. Sufficient for this surface (high-entropy random token,
  // not a low-entropy password). The unique index on secret_hash makes
  // validation an O(log n) lookup.
  return createHash('sha256').update(plaintext).digest('hex');
}

function isScimSecret(value: string): boolean {
  return typeof value === 'string' && value.startsWith(SCIM_TOKEN_PREFIX);
}

interface CreateScimTokenInput {
  accountId: string;
  name: string;
  createdBy: string;
  expiresAt?: Date;
}

interface CreateScimTokenResult {
  tokenId: string;
  name: string;
  /** Plaintext — returned only at creation. Show once, never store. */
  secret: string;
  publicPrefix: string;
  createdAt: Date;
  expiresAt: Date | null;
}

export async function createScimToken(
  input: CreateScimTokenInput,
): Promise<CreateScimTokenResult> {
  const secret = generateScimSecret();
  // Display-only fingerprint so admins can recognise tokens after creation
  // without revealing the full secret. e.g. "kortix_scim_AbCd..."
  const publicPrefix = secret.slice(0, SCIM_TOKEN_PREFIX.length + 4) + '…';
  const [row] = await db
    .insert(scimTokens)
    .values({
      accountId: input.accountId,
      name: input.name,
      secretHash: hashScimSecret(secret),
      publicPrefix,
      createdBy: input.createdBy,
      expiresAt: input.expiresAt ?? null,
    })
    .returning();
  return {
    tokenId: row.tokenId,
    name: row.name,
    secret,
    publicPrefix: row.publicPrefix,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

interface ScimTokenSummary {
  tokenId: string;
  name: string;
  publicPrefix: string;
  status: 'active' | 'expired' | 'revoked';
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

function tokenStatus(row: {
  revokedAt: Date | null;
  expiresAt: Date | null;
}): ScimTokenSummary['status'] {
  if (row.revokedAt) return 'revoked';
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return 'expired';
  return 'active';
}

export async function listScimTokens(accountId: string): Promise<ScimTokenSummary[]> {
  const rows = await db
    .select()
    .from(scimTokens)
    .where(eq(scimTokens.accountId, accountId))
    .orderBy(desc(scimTokens.createdAt));
  return rows.map((r) => ({
    tokenId: r.tokenId,
    name: r.name,
    publicPrefix: r.publicPrefix,
    status: tokenStatus(r),
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt,
    expiresAt: r.expiresAt,
    revokedAt: r.revokedAt,
  }));
}

export async function revokeScimToken(
  accountId: string,
  tokenId: string,
): Promise<boolean> {
  const rows = await db
    .update(scimTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(scimTokens.tokenId, tokenId),
        eq(scimTokens.accountId, accountId),
        isNull(scimTokens.revokedAt),
      ),
    )
    .returning({ tokenId: scimTokens.tokenId });
  return rows.length > 0;
}

interface ValidateScimResult {
  ok: boolean;
  accountId?: string;
  tokenId?: string;
  reason?: 'malformed' | 'unknown' | 'revoked' | 'expired';
}

/**
 * Bearer-token validation. Hash lookup is O(log n) via the unique index.
 * On success we touch last_used_at (fire-and-forget so the request path
 * isn't blocked by the write).
 */
export async function validateScimToken(plaintext: string): Promise<ValidateScimResult> {
  if (!isScimSecret(plaintext)) return { ok: false, reason: 'malformed' };
  const hash = hashScimSecret(plaintext);
  const [row] = await db
    .select()
    .from(scimTokens)
    .where(eq(scimTokens.secretHash, hash))
    .limit(1);
  if (!row) return { ok: false, reason: 'unknown' };
  if (row.revokedAt) return { ok: false, reason: 'revoked' };
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
    return { ok: false, reason: 'expired' };
  }

  // Async last-used update — never block the validate path on it.
  db.update(scimTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(scimTokens.tokenId, row.tokenId))
    .catch((err) => {
      console.warn('[scim] last_used_at update failed', err);
    });

  return { ok: true, accountId: row.accountId, tokenId: row.tokenId };
}
