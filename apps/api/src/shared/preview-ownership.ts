/**
 * Preview proxy ownership gate. Thin wrapper around the teams module's
 * canAccessPreviewTarget — this file exists purely to (a) add the per-user
 * cache and (b) keep a stable import path for the auth middleware.
 */

import { db } from './db';
import { resolveAccountId } from './resolve-account';
import { canAccessPreviewTarget, loadUserTeamContext } from '../teams';

const CACHE_TTL_MS = 5 * 60 * 1000;

type CacheEntry = {
  allowed: boolean;
  expiresAt: number;
};

// Per-user cache. Two users in the same account can legitimately have
// different sandbox visibility (thanks to sandbox_members), so caching
// on accountId would let one user's decision leak to another.
const ownershipCache = new Map<string, CacheEntry>();

function cacheKey(previewSandboxId: string, userId: string): string {
  return `${previewSandboxId}:${userId}`;
}

export async function canAccessPreviewSandbox(input: {
  previewSandboxId: string;
  userId?: string;
  accountId?: string;
}): Promise<boolean> {
  const userId = input.userId;
  if (!userId) return false;

  const key = cacheKey(input.previewSandboxId, userId);
  const cached = ownershipCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.allowed;
  }

  const primaryAccountId = input.accountId || (await resolveAccountId(userId));
  const ctx = await loadUserTeamContext(db, userId, primaryAccountId);
  const allowed = await canAccessPreviewTarget(db, ctx, input.previewSandboxId);

  ownershipCache.set(key, { allowed, expiresAt: Date.now() + CACHE_TTL_MS });
  return allowed;
}

export function clearPreviewOwnershipCache(): void {
  ownershipCache.clear();
}
