import { eq, and, desc, inArray } from 'drizzle-orm';
import { accountTokens, accounts } from '@kortix/db';
import { Effect } from 'effect';
import { DatabaseService } from '../effect/services';
import { runEffectOrThrow } from '../effect/http';
import {
  hashSecretKey,
  candidateSecretKeyHashes,
  generateAccountTokenPair,
  isApiKeySecretConfigured,
  isAccountToken,
} from '../shared/crypto';
import type { AgentGrant } from '@kortix/db';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AccountTokenValidationResult {
  isValid: boolean;
  accountId?: string;
  userId?: string;
  tokenId?: string;
  /** Non-null = this token is scoped to one project; the auth
   *  middleware enforces URL :projectId === this value. */
  projectId?: string | null;
  /** Non-null = this token belongs to a specific session (sandbox executor
   *  token, session_id = sandbox_id). Used to attribute LLM usage per-session. */
  sessionId?: string | null;
  /** Non-null = this is an agent-session token; the running agent's resolved
   *  authorization (which Kortix CLI/API actions + connectors it may use,
   *  already ∩ the launching user). Null = full access (laptop CLI PAT). */
  agentGrant?: AgentGrant | null;
  error?: string;
}

export interface CreateAccountTokenParams {
  accountId: string;
  userId: string;
  name: string;
  /** Non-null = token is scoped to one project. Session executor tokens also
   *  set sessionId + agentGrant. Null/undefined = user-scoped laptop CLI PAT. */
  projectId?: string;
  /** Set for sandbox session tokens (session_id = sandbox_id) so LLM usage
   *  through the gateway is attributed to the session. */
  sessionId?: string | null;
  expiresAt?: Date;
  /** Set for agent-session tokens — the resolved per-agent grant to stamp
   *  onto the token (already ∩ the launching user's role). */
  agentGrant?: AgentGrant | null;
  /** The agent's standing-identity service account. When set, the IAM engine
   *  authorizes this session AS the SA (its own policies) ∩ agentGrant, not the
   *  launching user. Null = legacy (authorize as the user). */
  serviceAccountId?: string | null;
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

const loadPatPolicyEffect = (accountId: string): Effect.Effect<{
  maxLifetimeDays: number | null;
  requireExpiry: boolean;
  idleRevokeDays: number | null;
} | null, unknown, DatabaseService> =>
  Effect.gen(function* () {
    const { database } = yield* DatabaseService;
    const [row] = yield* Effect.tryPromise(() =>
      database
        .select({
          maxLifetimeDays: accounts.patMaxLifetimeDays,
          requireExpiry: accounts.patRequireExpiry,
          idleRevokeDays: accounts.patIdleRevokeDays,
        })
        .from(accounts)
        .where(eq(accounts.accountId, accountId))
        .limit(1),
    );
    return row ?? null;
  });

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
  return runEffectOrThrow(Effect.gen(function* () {
    const { database } = yield* DatabaseService;
    if (!isApiKeySecretConfigured()) {
      throw new Error('API_KEY_SECRET not configured');
    }

    if (!params.projectId) {
      const policy = yield* loadPatPolicyEffect(params.accountId);
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

    const [row] = yield* Effect.tryPromise(() =>
      database
        .insert(accountTokens)
        .values({
          accountId: params.accountId,
          userId: params.userId,
          projectId: params.projectId ?? null,
          sessionId: params.sessionId ?? null,
          name: params.name,
          publicKey,
          secretKeyHash,
          expiresAt: params.expiresAt ?? null,
          agentGrant: params.agentGrant ?? null,
          serviceAccountId: params.serviceAccountId ?? null,
        })
        .returning(),
    );

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
  }));
}

/** List tokens for an account. If `projectId` is provided, narrows to
 *  tokens scoped to that project (useful for the per-project token
 *  management UI). Never returns secret data. */
export async function listAccountTokens(
  accountId: string,
  projectId?: string,
): Promise<AccountTokenListEntry[]> {
  return runEffectOrThrow(Effect.gen(function* () {
    const { database } = yield* DatabaseService;
    const filter = projectId
      ? and(eq(accountTokens.accountId, accountId), eq(accountTokens.projectId, projectId))
      : eq(accountTokens.accountId, accountId);
    return yield* Effect.tryPromise(() =>
      database
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
        .orderBy(desc(accountTokens.createdAt)),
    );
  }));
}

/** Revoke a token (soft-delete — sets status='revoked' + revoked_at). */
export async function revokeAccountToken(
  tokenId: string,
  accountId: string,
): Promise<boolean> {
  return runEffectOrThrow(Effect.gen(function* () {
    const { database } = yield* DatabaseService;
    const result = yield* Effect.tryPromise(() =>
      database
        .update(accountTokens)
        .set({ status: 'revoked', revokedAt: new Date() })
        .where(
          and(
            eq(accountTokens.tokenId, tokenId),
            eq(accountTokens.accountId, accountId),
            eq(accountTokens.status, 'active'),
          ),
        )
        .returning({ tokenId: accountTokens.tokenId }),
    );

    return result.length > 0;
  }));
}

// ─── Validation ──────────────────────────────────────────────────────────────

/**
 * Validate a CLI Personal Access Token (kortix_pat_... prefix).
 * Returns the account + user id on success.
 */
export async function validateAccountToken(
  secretKey: string,
): Promise<AccountTokenValidationResult> {
  return runEffectOrThrow(Effect.gen(function* () {
    const { database } = yield* DatabaseService;
    if (!isApiKeySecretConfigured()) {
      return { isValid: false, error: 'API_KEY_SECRET not configured' };
    }

    if (!isAccountToken(secretKey)) {
      return { isValid: false, error: 'Invalid PAT format — expected kortix_pat_ prefix' };
    }

    const secretKeyHashes = candidateSecretKeyHashes(secretKey);

    // Join the owning account so we can apply idle-revoke without a
    // second round-trip on the hot path.
    const [row] = yield* Effect.tryPromise(() =>
      database
        .select({
          tokenId: accountTokens.tokenId,
          accountId: accountTokens.accountId,
          userId: accountTokens.userId,
          projectId: accountTokens.projectId,
          sessionId: accountTokens.sessionId,
          status: accountTokens.status,
          expiresAt: accountTokens.expiresAt,
          lastUsedAt: accountTokens.lastUsedAt,
          createdAt: accountTokens.createdAt,
          agentGrant: accountTokens.agentGrant,
          patIdleRevokeDays: accounts.patIdleRevokeDays,
        })
        .from(accountTokens)
        .innerJoin(accounts, eq(accounts.accountId, accountTokens.accountId))
        .where(
          and(
            inArray(accountTokens.secretKeyHash, secretKeyHashes),
            eq(accountTokens.status, 'active'),
          ),
        )
        .limit(1),
    );

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
        yield* Effect.forkDaemon(
          Effect.tryPromise(() =>
            database
              .update(accountTokens)
              .set({ status: 'revoked', revokedAt: new Date() })
              .where(eq(accountTokens.tokenId, row.tokenId)),
          ).pipe(
            Effect.catchAll((err) =>
              Effect.sync(() => {
                console.warn('PAT idle auto-revoke failed:', err);
              }),
            ),
          ),
        );
        return { isValid: false, error: 'PAT auto-revoked due to inactivity' };
      }
    }

    yield* Effect.forkDaemon(updateLastUsedThrottledEffect(row.tokenId));

    return {
      isValid: true,
      accountId: row.accountId,
      userId: row.userId,
      tokenId: row.tokenId,
      projectId: row.projectId,
      sessionId: row.sessionId ?? null,
      agentGrant: row.agentGrant ?? null,
    };
  }).pipe(
    Effect.catchAll((err) =>
      Effect.sync(() => {
        console.error('Account token validation error:', err);
        return { isValid: false, error: 'Validation error' };
      }),
    ),
  ));
}

// ─── Internal ────────────────────────────────────────────────────────────────

const updateLastUsedThrottledEffect = (tokenId: string) =>
  Effect.gen(function* () {
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

    const { database } = yield* DatabaseService;
    yield* Effect.tryPromise(() =>
      database
        .update(accountTokens)
        .set({ lastUsedAt: new Date() })
        .where(eq(accountTokens.tokenId, tokenId)),
    ).pipe(
      Effect.catchAll((err) =>
        Effect.sync(() => {
          console.warn('Failed to update account_tokens.last_used_at:', err);
        }),
      ),
    );
  });
