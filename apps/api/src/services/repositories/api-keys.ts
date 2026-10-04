import { eq, and, inArray } from 'drizzle-orm';
import { kortixApiKeys } from '@kortix/db';
import { db } from '../../lib/db';
import { createLastUsedTracker } from './throttled-last-used';
import { candidateSecretKeyHashesAsync, markTokenValidated } from '../auth/token-hash';
import {
  hashSecretKey,
  generateApiKeyPair,
  generateSandboxKeyPair,
  isApiKeySecretConfigured,
  isGatewayKey,
  isKortixToken,
  isAccountToken,
  isServiceAccountToken,
  isTunnelToken,
} from '../../lib/crypto';
import { isOAuthAccessToken, isOAuthRefreshToken } from '../oauth/access-token';

// ─── Types ───────────────────────────────────────────────────────────────────

type ApiKeyType = 'user' | 'sandbox';

export interface ApiKeyValidationResult {
  isValid: boolean;
  accountId?: string;
  sandboxId?: string;
  keyId?: string;
  type?: ApiKeyType;
  error?: string;
}

export interface CreateApiKeyParams {
  sandboxId: string;
  accountId: string;
  title: string;
  description?: string;
  expiresAt?: Date;
  type?: ApiKeyType;
}

export interface CreateApiKeyResult {
  keyId: string;
  publicKey: string;
  secretKey: string; // returned ONCE at creation, never stored
  title: string;
  description: string | null;
  status: string;
  type: ApiKeyType;
  sandboxId: string;
  expiresAt: Date | null;
  createdAt: Date;
}

// ─── Throttle for last_used_at updates ───────────────────────────────────────

const updateLastUsedThrottled = createLastUsedTracker((keyId) =>
  db.update(kortixApiKeys).set({ lastUsedAt: new Date() }).where(eq(kortixApiKeys.keyId, keyId)),
);

// ─── CRUD Operations ─────────────────────────────────────────────────────────

/**
 * Create a new API key scoped to a sandbox.
 * Returns the secret key in plaintext ONCE — only the hash is stored.
 *
 * type='user'    → kortix_<32> secret key (user-created, external access)
 * type='sandbox' → kortix_sb_<32> secret key (auto-managed, injected into sandbox)
 */
export async function createApiKey(params: CreateApiKeyParams): Promise<CreateApiKeyResult> {
  if (!isApiKeySecretConfigured()) {
    throw new Error('API_KEY_SECRET not configured');
  }

  const keyType = params.type ?? 'user';
  const { publicKey, secretKey } = keyType === 'sandbox'
    ? generateSandboxKeyPair()
    : generateApiKeyPair();
  const secretKeyHash = hashSecretKey(secretKey);

  const [row] = await db
    .insert(kortixApiKeys)
    .values({
      sandboxId: params.sandboxId,
      accountId: params.accountId,
      publicKey,
      secretKeyHash,
      title: params.title,
      description: params.description ?? null,
      type: keyType,
      expiresAt: params.expiresAt ?? null,
    })
    .returning();

  if (!row) {
    throw new Error('Failed to create API key');
  }

  return {
    keyId: row.keyId,
    publicKey: row.publicKey,
    secretKey, // plaintext — shown once
    title: row.title,
    description: row.description,
    status: row.status,
    type: row.type as ApiKeyType,
    sandboxId: row.sandboxId,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

/**
 * List all API keys for a sandbox. Never returns secret data.
 */
export async function listApiKeys(sandboxId: string) {
  return db
    .select({
      keyId: kortixApiKeys.keyId,
      publicKey: kortixApiKeys.publicKey,
      title: kortixApiKeys.title,
      description: kortixApiKeys.description,
      type: kortixApiKeys.type,
      status: kortixApiKeys.status,
      sandboxId: kortixApiKeys.sandboxId,
      expiresAt: kortixApiKeys.expiresAt,
      lastUsedAt: kortixApiKeys.lastUsedAt,
      createdAt: kortixApiKeys.createdAt,
    })
    .from(kortixApiKeys)
    .where(eq(kortixApiKeys.sandboxId, sandboxId));
}

/**
 * Revoke an API key (soft-delete — sets status to 'revoked').
 */
export async function revokeApiKey(keyId: string, accountId: string): Promise<boolean> {
  const result = await db
    .update(kortixApiKeys)
    .set({ status: 'revoked' })
    .where(
      and(
        eq(kortixApiKeys.keyId, keyId),
        eq(kortixApiKeys.accountId, accountId),
        eq(kortixApiKeys.status, 'active'),
      ),
    )
    .returning({ keyId: kortixApiKeys.keyId });

  return result.length > 0;
}

/**
 * Hard-delete an API key.
 */
export async function deleteApiKey(keyId: string, accountId: string): Promise<boolean> {
  const result = await db
    .delete(kortixApiKeys)
    .where(
      and(
        eq(kortixApiKeys.keyId, keyId),
        eq(kortixApiKeys.accountId, accountId),
      ),
    )
    .returning({ keyId: kortixApiKeys.keyId });

  return result.length > 0;
}

// ─── Validation ──────────────────────────────────────────────────────────────

/**
 * Validate a Kortix API key (kortix_ or kortix_sb_ prefix).
 * Single validation path for all key types — returns account_id, sandbox_id, and key type.
 */
export async function validateSecretKey(secretKey: string): Promise<ApiKeyValidationResult> {
  if (!isApiKeySecretConfigured()) {
    return { isValid: false, error: 'API_KEY_SECRET not configured' };
  }

  if (!isKortixToken(secretKey)) {
    return { isValid: false, error: 'Invalid API key format — expected kortix_ prefix' };
  }

  // A credential minted into one of the platform's other tables — a session or
  // CLI PAT, a service account, a gateway key, a tunnel token, an OAuth token —
  // can never match kortix_api_keys. Refuse it by shape: no doomed indexed
  // probe and an error that names the presented credential, not "not found"
  // (prod 2026-10-03: one client presenting its session PAT to /v1/router/*
  // wrote 71 "Token not found in DB" warns in a minute; the token was valid).
  const foreign = isAccountToken(secretKey) ? 'a personal access token (kortix_pat_)'
    : isServiceAccountToken(secretKey) ? 'a service-account token (kortix_sa_)'
    : isGatewayKey(secretKey) ? 'a gateway key (kortix_gw_)'
    : isTunnelToken(secretKey) ? 'a tunnel token (kortix_tnl_)'
    : isOAuthAccessToken(secretKey) ? 'an OAuth access token (kortix_oat_)'
    : isOAuthRefreshToken(secretKey) ? 'an OAuth refresh token (kortix_ort_)'
    : null;
  if (foreign) {
    return { isValid: false, error: `Invalid API key format — ${foreign} is not an API key` };
  }

  try {
    const secretKeyHashes = await candidateSecretKeyHashesAsync(secretKey);

    const [row] = await db
      .select({
        keyId: kortixApiKeys.keyId,
        accountId: kortixApiKeys.accountId,
        sandboxId: kortixApiKeys.sandboxId,
        type: kortixApiKeys.type,
        status: kortixApiKeys.status,
        expiresAt: kortixApiKeys.expiresAt,
      })
      .from(kortixApiKeys)
      .where(
        and(
          inArray(kortixApiKeys.secretKeyHash, secretKeyHashes),
          eq(kortixApiKeys.status, 'active'),
        ),
      )
      .limit(1);

    if (!row) {
      // No second probe query here: a miss must cost one indexed lookup, not
      // two, because anyone can present an unknown token.
      console.warn(`[validateSecretKey] Token not found in DB. hash=${secretKeyHashes[0]!.slice(0, 16)}... prefix="${secretKey.slice(0, 20)}..."`);
      return { isValid: false, error: 'API key not found or invalid' };
    }

    if (row.expiresAt && row.expiresAt < new Date()) {
      return { isValid: false, error: 'API key expired' };
    }

    markTokenValidated(secretKey);
    // Fire-and-forget: update last_used_at (throttled)
    updateLastUsedThrottled(row.keyId).catch(() => {});

    return {
      isValid: true,
      accountId: row.accountId,
      sandboxId: row.sandboxId,
      keyId: row.keyId,
      type: row.type as ApiKeyType,
    };
  } catch (err) {
    console.error('API key validation error:', err);
    return { isValid: false, error: 'Validation error' };
  }
}
