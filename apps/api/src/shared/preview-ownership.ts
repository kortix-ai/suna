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
import { isSessionVisibleTo, loadSessionGrants, resolveShareSubject } from '../executor/share';
import { accountMembers, projectSessions, sessionSandboxes } from '@kortix/db';
import { and, eq, or } from 'drizzle-orm';
import type { KortixUserContext } from './kortix-user-context';

const CACHE_TTL_MS = 5 * 60 * 1000;

// ─── Session-visibility gate for the daemon/opencode port ────────────────────
// canAccessPreviewSandbox above authorizes on ACCOUNT MEMBERSHIP only. That is
// correct for preview web ports, but the daemon port (8000) reverse-proxies a
// session's OpenCode conversation + its owner's synced secrets — which is
// governed by SESSION VISIBILITY (private | project | restricted), enforced on
// the REST routes via loadVisibleSession but historically NOT on this data
// path. Without this, a same-account member who once had access to a session
// (so their client captured the sandbox + opencode ids) could keep reading /
// posting to it via /v1/p/<ext>/8000/session/... after the owner made it
// private or revoked their grant. Mirror the REST check here. Short TTL keeps
// the hot path cheap; revocation lags at most one window (matches the existing
// membership cache trade-off).
const SESSION_VISIBILITY_TTL_MS = 10_000;
const sessionVisibilityCache = new Map<string, { allowed: boolean; expiresAt: number }>();

/**
 * Whether `userId` may reach the SESSION behind a sandbox (daemon-port traffic).
 * Returns true when there is no project_session row for the sandbox (pool /
 * builder boxes that aren't user sessions) so non-session proxy use is
 * unaffected — the account-membership gate still applies to those.
 */
export async function canAccessSandboxSession(input: {
  sessionId: string;
  projectId: string;
  accountId: string;
  userId: string;
}): Promise<boolean> {
  const key = `${input.sessionId}|${input.userId}`;
  const cached = sessionVisibilityCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.allowed;

  const [row] = await db
    .select({ visibility: projectSessions.visibility, createdBy: projectSessions.createdBy })
    .from(projectSessions)
    .where(
      and(
        eq(projectSessions.sessionId, input.sessionId),
        eq(projectSessions.projectId, input.projectId),
        eq(projectSessions.accountId, input.accountId),
      ),
    )
    .limit(1);

  let allowed = true;
  if (row) {
    const subject = await resolveShareSubject(input.userId);
    const grants = (await loadSessionGrants([input.sessionId])).get(input.sessionId) ?? [];
    allowed = isSessionVisibleTo(
      row.visibility as 'private' | 'project' | 'restricted',
      row.createdBy,
      grants,
      subject,
    );
  }
  sessionVisibilityCache.set(key, { allowed, expiresAt: Date.now() + SESSION_VISIBILITY_TTL_MS });
  return allowed;
}

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
