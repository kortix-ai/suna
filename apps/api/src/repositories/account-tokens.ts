import { eq, and, desc } from 'drizzle-orm';
import { accountTokens } from '@kortix/db';
import { db } from '../shared/db';
import {
  hashSecretKey,
  generateAccountTokenPair,
  isApiKeySecretConfigured,
  isAccountToken,
} from '../shared/crypto';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AccountTokenValidationResult {
  isValid: boolean;
  accountId?: string;
  userId?: string;
  tokenId?: string;
  /** Non-null = this token is scoped to one project; the auth
   *  middleware enforces URL :projectId === this value. */
  projectId?: string | null;
  error?: string;
}

export interface CreateAccountTokenParams {
  accountId: string;
  userId: string;
  name: string;
  /** Non-null = project-scoped token (sandbox injection). Null/undefined
   *  = user-scoped (laptop CLI). */
  projectId?: string;
  expiresAt?: Date;
}

export interface CreateAccountTokenResult {
  tokenId: string;
  publicKey: string;
  secretKey: string; // plaintext — shown ONCE at creation
  name: string;
  status: string;
  projectId: string | null;
  expiresAt: Date | null;
  createdAt: Date;
}

export interface AccountTokenListEntry {
  tokenId: string;
  publicKey: string;
  name: string;
  status: string;
  projectId: string | null;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
  revokedAt: Date | null;
}

// ─── Throttle for last_used_at updates ───────────────────────────────────────

const THROTTLE_MS = 15 * 60 * 1000;
const lastUsedCache = new Map<string, number>();

// ─── CRUD Operations ─────────────────────────────────────────────────────────

/**
 * Mint a new CLI Personal Access Token.
 * Returns the plaintext secret ONCE — only its hash is persisted.
 */
export async function createAccountToken(
  params: CreateAccountTokenParams,
): Promise<CreateAccountTokenResult> {
  if (!isApiKeySecretConfigured()) {
    throw new Error('API_KEY_SECRET not configured');
  }

  const { publicKey, secretKey } = generateAccountTokenPair();
  const secretKeyHash = hashSecretKey(secretKey);

  const [row] = await db
    .insert(accountTokens)
    .values({
      accountId: params.accountId,
      userId: params.userId,
      projectId: params.projectId ?? null,
      name: params.name,
      publicKey,
      secretKeyHash,
      expiresAt: params.expiresAt ?? null,
    })
    .returning();

  if (!row) {
    throw new Error('Failed to create account token');
  }

  return {
    tokenId: row.tokenId,
    publicKey: row.publicKey,
    secretKey, // plaintext — shown once
    name: row.name,
    status: row.status,
    projectId: row.projectId,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

/** List tokens for an account. If `projectId` is provided, narrows to
 *  tokens scoped to that project (useful for the per-project token
 *  management UI). Never returns secret data. */
export async function listAccountTokens(
  accountId: string,
  projectId?: string,
): Promise<AccountTokenListEntry[]> {
  const filter = projectId
    ? and(eq(accountTokens.accountId, accountId), eq(accountTokens.projectId, projectId))
    : eq(accountTokens.accountId, accountId);
  return db
    .select({
      tokenId: accountTokens.tokenId,
      publicKey: accountTokens.publicKey,
      name: accountTokens.name,
      status: accountTokens.status,
      projectId: accountTokens.projectId,
      expiresAt: accountTokens.expiresAt,
      lastUsedAt: accountTokens.lastUsedAt,
      createdAt: accountTokens.createdAt,
      revokedAt: accountTokens.revokedAt,
    })
    .from(accountTokens)
    .where(filter)
    .orderBy(desc(accountTokens.createdAt));
}

/** Revoke a token (soft-delete — sets status='revoked' + revoked_at). */
export async function revokeAccountToken(
  tokenId: string,
  accountId: string,
): Promise<boolean> {
  const result = await db
    .update(accountTokens)
    .set({ status: 'revoked', revokedAt: new Date() })
    .where(
      and(
        eq(accountTokens.tokenId, tokenId),
        eq(accountTokens.accountId, accountId),
        eq(accountTokens.status, 'active'),
      ),
    )
    .returning({ tokenId: accountTokens.tokenId });

  return result.length > 0;
}

// ─── Validation ──────────────────────────────────────────────────────────────

/**
 * Validate a CLI Personal Access Token (kortix_pat_... prefix).
 * Returns the account + user id on success.
 */
export async function validateAccountToken(
  secretKey: string,
): Promise<AccountTokenValidationResult> {
  if (!isApiKeySecretConfigured()) {
    return { isValid: false, error: 'API_KEY_SECRET not configured' };
  }

  if (!isAccountToken(secretKey)) {
    return { isValid: false, error: 'Invalid PAT format — expected kortix_pat_ prefix' };
  }

  try {
    const secretKeyHash = hashSecretKey(secretKey);

    const [row] = await db
      .select({
        tokenId: accountTokens.tokenId,
        accountId: accountTokens.accountId,
        userId: accountTokens.userId,
        projectId: accountTokens.projectId,
        status: accountTokens.status,
        expiresAt: accountTokens.expiresAt,
      })
      .from(accountTokens)
      .where(
        and(
          eq(accountTokens.secretKeyHash, secretKeyHash),
          eq(accountTokens.status, 'active'),
        ),
      )
      .limit(1);

    if (!row) {
      return { isValid: false, error: 'PAT not found or revoked' };
    }

    if (row.expiresAt && row.expiresAt < new Date()) {
      return { isValid: false, error: 'PAT expired' };
    }

    updateLastUsedThrottled(row.tokenId).catch(() => {});

    return {
      isValid: true,
      accountId: row.accountId,
      userId: row.userId,
      tokenId: row.tokenId,
      projectId: row.projectId,
    };
  } catch (err) {
    console.error('Account token validation error:', err);
    return { isValid: false, error: 'Validation error' };
  }
}

// ─── Internal ────────────────────────────────────────────────────────────────

async function updateLastUsedThrottled(tokenId: string): Promise<void> {
  const now = Date.now();
  const lastUpdate = lastUsedCache.get(tokenId) || 0;
  if (now - lastUpdate < THROTTLE_MS) return;

  lastUsedCache.set(tokenId, now);
  if (lastUsedCache.size > 1000) {
    const cutoff = now - THROTTLE_MS * 2;
    for (const [k, v] of lastUsedCache.entries()) {
      if (v < cutoff) lastUsedCache.delete(k);
    }
  }

  try {
    await db
      .update(accountTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(accountTokens.tokenId, tokenId));
  } catch (err) {
    console.warn('Failed to update account_tokens.last_used_at:', err);
  }
}
