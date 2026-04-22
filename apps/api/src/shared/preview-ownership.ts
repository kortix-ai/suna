/**
 * Preview proxy ownership gate + user-context resolver.
 *
 * Two responsibilities:
 *   1. Tell the preview proxy whether a given user can reach a sandbox.
 *   2. Produce the payload the proxy signs and forwards as
 *      `X-Kortix-User-Context` to kortix-master (Phase 1 of the multi-user
 *      authorization layer).
 *
 * Both share one cache keyed by (previewSandboxId, userId) — the heavy cost
 * is the membership lookup, not the signing. Signing happens per request
 * on top of a cached context so freshly-revoked tokens aren't served.
 */

import { db } from './db';
import { resolveAccountId } from './resolve-account';
import {
  canAccessPreviewTarget,
  decideAccess,
  loadUserTeamContext,
} from '../teams';
import { sandboxes } from '@kortix/db';
import { eq, or } from 'drizzle-orm';
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
 * Resolve the REAL sandbox uuid + account id from the `previewSandboxId`,
 * which can be either a uuid or an externalId (container name / provider id).
 */
async function resolveSandboxRef(
  previewSandboxId: string,
): Promise<{ sandboxId: string; accountId: string } | null> {
  const idCondition = UUID_RE.test(previewSandboxId)
    ? or(
        eq(sandboxes.externalId, previewSandboxId),
        eq(sandboxes.sandboxId, previewSandboxId),
      )
    : eq(sandboxes.externalId, previewSandboxId);

  const [row] = await db
    .select({ sandboxId: sandboxes.sandboxId, accountId: sandboxes.accountId })
    .from(sandboxes)
    .where(idCondition)
    .limit(1);

  return row ?? null;
}

async function computeEntry(
  previewSandboxId: string,
  userId: string,
): Promise<CacheEntry> {
  const expiresAt = Date.now() + CACHE_TTL_MS;

  const ref = await resolveSandboxRef(previewSandboxId);
  const primaryAccountId = await resolveAccountId(userId);
  const ctx = await loadUserTeamContext(db, userId, primaryAccountId);

  // Sandbox row couldn't be resolved (rare — e.g. local-docker discovery
  // path). Fall back to the boolean check; identity still forwards.
  if (!ref) {
    const allowed = await canAccessPreviewTarget(db, ctx, previewSandboxId);
    return {
      allowed,
      payload: allowed
        ? {
            userId,
            sandboxId: previewSandboxId,
            sandboxRole: 'platform_admin',
          }
        : null,
      expiresAt,
    };
  }

  const decision = await decideAccess(
    db,
    ctx,
    { sandboxId: ref.sandboxId, accountId: ref.accountId },
    'view',
  );
  if (!decision.allowed) {
    return { allowed: false, payload: null, expiresAt };
  }

  let sandboxRole: KortixUserContext['sandboxRole'];
  if (ctx.isPlatformAdmin) {
    sandboxRole = 'platform_admin';
  } else if (ctx.ownerAccountIds.includes(ref.accountId)) {
    sandboxRole = 'owner';
  } else if (ctx.managerAccountIds.includes(ref.accountId)) {
    sandboxRole = 'admin';
  } else {
    sandboxRole = 'member';
  }

  // Project ACLs are resolved inside the sandbox (kortix-master owns the
  // table), so the signed payload stays identity-only.
  return {
    allowed: true,
    payload: {
      userId,
      sandboxId: ref.sandboxId,
      sandboxRole,
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
  if (!input.userId) return false;
  const entry = await getOrCompute(input.previewSandboxId, input.userId);
  return entry.allowed;
}

/**
 * Payload ready to sign + forward as `X-Kortix-User-Context`. Null when the
 * caller isn't authenticated or isn't allowed on this sandbox — caller should
 * skip attaching the header in that case.
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

/**
 * Drop every cached entry for a user. Call when their memberships or role
 * changes so the next proxy request re-evaluates from the database.
 */
export function invalidatePreviewCacheForUser(userId: string): void {
  const suffix = `:${userId}`;
  for (const key of previewContextCache.keys()) {
    if (key.endsWith(suffix)) {
      previewContextCache.delete(key);
    }
  }
}


