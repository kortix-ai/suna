/**
 * Preview proxy ownership gate + user-context resolver.
 *
 * Project-sessions on Daytona model:
 *   - A sandbox lives in `kortix.session_sandboxes`.
 *   - A user can hit the sandbox if they're a member of the account that owns
 *     it (account_members.account_id == session_sandboxes.account_id), or if
 *     they're a platform admin.
 *
 * The legacy sandbox-members / scope / role machinery has been removed along
 * with the rest of the /instances surface.
 */

import { db } from './db';
import { isPlatformAdmin } from './platform-roles';
import { resolveAccountId } from './resolve-account';
import { accountMembers, sessionSandboxes } from '@kortix/db';
import { and, eq, or } from 'drizzle-orm';
import type { KortixUserContext } from './kortix-user-context';

const CACHE_TTL_MS = 5 * 60 * 1000;

type CacheEntry = {
  allowed: boolean;
  /** Null when access is denied or the caller is anonymous. */
  payload: Omit<KortixUserContext, 'iat' | 'exp'> | null;
  expiresAt: number;
};

const previewContextCache = new Map<string, CacheEntry>();

function cacheKey(previewSandboxId: string, userId: string): string {
  return `${previewSandboxId}:${userId}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve the real session sandbox uuid + owning account from a
 * `previewSandboxId`, which can be either a uuid (sandboxId / externalId) or
 * the Daytona-side externalId string.
 */
async function resolveSandboxRef(
  previewSandboxId: string,
): Promise<{ sandboxId: string; accountId: string } | null> {
  const idCondition = UUID_RE.test(previewSandboxId)
    ? or(
        eq(sessionSandboxes.externalId, previewSandboxId),
        eq(sessionSandboxes.sandboxId, previewSandboxId),
      )
    : eq(sessionSandboxes.externalId, previewSandboxId);

  const [row] = await db
    .select({ sandboxId: sessionSandboxes.sandboxId, accountId: sessionSandboxes.accountId })
    .from(sessionSandboxes)
    .where(idCondition)
    .limit(1);

  return row ?? null;
}

async function isAccountMember(userId: string, accountId: string): Promise<boolean> {
  const [row] = await db
    .select({ accountId: accountMembers.accountId })
    .from(accountMembers)
    .where(and(eq(accountMembers.userId, userId), eq(accountMembers.accountId, accountId)))
    .limit(1);
  return !!row;
}

async function computeEntry(
  previewSandboxId: string,
  userId: string,
): Promise<CacheEntry> {
  const expiresAt = Date.now() + CACHE_TTL_MS;

  const ref = await resolveSandboxRef(previewSandboxId);
  const primaryAccountId = await resolveAccountId(userId);
  const platformAdmin = await isPlatformAdmin(primaryAccountId);

  if (!ref) {
    // No sandbox row found. Allow only platform admins so the lookup-by-name
    // dev path (local bridge etc.) still works for staff debugging.
    return {
      allowed: platformAdmin,
      payload: platformAdmin
        ? {
            userId,
            sandboxId: previewSandboxId,
            sandboxRole: 'platform_admin',
            scopes: ['*'],
          }
        : null,
      expiresAt,
    };
  }

  const member = platformAdmin || (await isAccountMember(userId, ref.accountId));
  if (!member) {
    return { allowed: false, payload: null, expiresAt };
  }

  return {
    allowed: true,
    payload: {
      userId,
      sandboxId: ref.sandboxId,
      sandboxRole: platformAdmin ? 'platform_admin' : 'member',
      scopes: ['*'],
    },
    expiresAt,
  };
}

async function getOrCompute(
  previewSandboxId: string,
  userId: string,
): Promise<CacheEntry> {
  const key = cacheKey(previewSandboxId, userId);
  const cached = previewContextCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached;
  const fresh = await computeEntry(previewSandboxId, userId);
  previewContextCache.set(key, fresh);
  return fresh;
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function canAccessPreviewSandbox(input: {
  previewSandboxId: string;
  userId?: string;
  accountId?: string;
}): Promise<boolean> {
  if (!input.userId) {
    if (!input.accountId) return false;
    const ref = await resolveSandboxRef(input.previewSandboxId);
    return !!ref && ref.accountId === input.accountId;
  }
  const entry = await getOrCompute(input.previewSandboxId, input.userId);
  return entry.allowed;
}

/**
 * Payload ready to sign + forward as `X-Kortix-User-Context`. Null when the
 * caller isn't authenticated or isn't allowed on this sandbox.
 */
export async function resolvePreviewUserContext(
  previewSandboxId: string,
  userId: string | undefined,
): Promise<Omit<KortixUserContext, 'iat' | 'exp'> | null> {
  if (!userId) return null;
  const entry = await getOrCompute(previewSandboxId, userId);
  return entry.payload;
}

export function clearPreviewOwnershipCache(): void {
  previewContextCache.clear();
}

/** Drop every cached entry for a user. */
export function invalidatePreviewCacheForUser(userId: string): void {
  const suffix = `:${userId}`;
  for (const key of previewContextCache.keys()) {
    if (key.endsWith(suffix)) {
      previewContextCache.delete(key);
    }
  }
}
