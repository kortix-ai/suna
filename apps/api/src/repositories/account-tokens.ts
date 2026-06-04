import { eq, and, desc } from 'drizzle-orm';
import { accountTokens, accounts } from '@kortix/db';
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
 * Thrown when a PAT mint request violates the account's lifecycle policy.
 * Carries `code` + plain-English message; route handlers surface it as 400.
 */
export class PatPolicyError extends Error {
  constructor(
    public code: 'expiry_required' | 'expiry_too_far',
    message: string,
  ) {
    super(message);
    this.name = 'PatPolicyError';
  }
}

async function loadPatPolicy(accountId: string): Promise<{
  maxLifetimeDays: number | null;
  requireExpiry: boolean;
  idleRevokeDays: number | null;
} | null> {
  const [row] = await db
    .select({
      maxLifetimeDays: accounts.patMaxLifetimeDays,
      requireExpiry: accounts.patRequireExpiry,
      idleRevokeDays: accounts.patIdleRevokeDays,
    })
    .from(accounts)
    .where(eq(accounts.accountId, accountId))
    .limit(1);
  return row ?? null;
}

/**
 * Mint a new CLI Personal Access Token.
 * Returns the plaintext secret ONCE — only its hash is persisted.
 *
 * Enforces the account's PAT lifecycle policy:
 *   - require_expiry → must provide expires_at
 *   - max_lifetime_days → expires_at can't be more than N days out
 *
 * Project-scoped tokens (sandbox injection) are EXEMPT: they're short-
 * lived by construction (sandbox lifetime) and we don't want admin
 * policy to break the agent runtime.
 */
export async function createAccountToken(
  params: CreateAccountTokenParams,
): Promise<CreateAccountTokenResult> {
  if (!isApiKeySecretConfigured()) {
    throw new Error('API_KEY_SECRET not configured');
  }

  if (!params.projectId) {
    const policy = await loadPatPolicy(params.accountId);
    if (policy) {
      if (policy.requireExpiry && !params.expiresAt) {
        throw new PatPolicyError(
          'expiry_required',
          'This account requires every PAT to have an expiry date.',
        );
      }
      if (policy.maxLifetimeDays != null && params.expiresAt) {
        const maxMs = policy.maxLifetimeDays * 24 * 60 * 60 * 1000;
        if (params.expiresAt.getTime() - Date.now() > maxMs) {
          throw new PatPolicyError(
            'expiry_too_far',
            `Expiry cannot be more than ${policy.maxLifetimeDays} days from now.`,
          );
        }
      }
    }
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

    // Join the owning account so we can apply idle-revoke without a
    // second round-trip on the hot path.
    const [row] = await db
      .select({
        tokenId: accountTokens.tokenId,
        accountId: accountTokens.accountId,
        userId: accountTokens.userId,
        projectId: accountTokens.projectId,
        status: accountTokens.status,
        expiresAt: accountTokens.expiresAt,
        lastUsedAt: accountTokens.lastUsedAt,
        createdAt: accountTokens.createdAt,
        patIdleRevokeDays: accounts.patIdleRevokeDays,
      })
      .from(accountTokens)
      .innerJoin(accounts, eq(accounts.accountId, accountTokens.accountId))
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

    // Idle-revoke: if the account has an idle policy and the PAT hasn't
    // been used in that window, soft-revoke it now and refuse the call.
    // Project-scoped tokens (sandbox-injected, lifetime tied to the
    // sandbox) are exempt — same carve-out as the mint path.
    if (row.patIdleRevokeDays != null && !row.projectId) {
      const reference = row.lastUsedAt ?? row.createdAt;
      const idleMs = Date.now() - reference.getTime();
      const maxIdleMs = row.patIdleRevokeDays * 24 * 60 * 60 * 1000;
      if (idleMs > maxIdleMs) {
        // Soft-revoke in the background; don't block the response on it.
        db.update(accountTokens)
          .set({ status: 'revoked', revokedAt: new Date() })
          .where(eq(accountTokens.tokenId, row.tokenId))
          .catch((err) => {
            console.warn('PAT idle auto-revoke failed:', err);
          });
        return { isValid: false, error: 'PAT auto-revoked due to inactivity' };
      }
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
