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
import {
  isProjectSessionVisibleTo,
  isTriggerCreatedSessionMetadata,
  loadSessionGrants,
  resolveShareSubject,
} from '../connectors/share';
import { authorize } from '../iam';
import { actorForUser } from '../iam/actor';
import { accountMembers, projectSessions, sessionEnvironments, sessionSandboxes } from '@kortix/db';
import { and, eq, or, sql } from 'drizzle-orm';
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
  /** The caller's own session when the credential is bound to one, or null.
   *  REQUIRED — an omitted binding would fail open. */
  callerSessionId: string | null;
  /** The caller's AGENT/SANDBOX token binding (`callerKortixSessionId(c)`).
   *  Only the trigger-session manager override reads it — see share.ts. */
  boundCredentialSessionId: string | null;
}): Promise<boolean> {
  // callerSessionId MUST be in the key. In Kortix-as-a-Backend every end-user
  // shares one `userId` (the wrapper credential), so without it end-user A and
  // end-user B collide on one entry for the same target session — and the first
  // `true` would be served to everyone else for the whole TTL, silently
  // defeating the isolation check below.
  // boundCredentialSessionId is in the key for the same reason callerSessionId
  // is: it changes the verdict (it gates the manager override), so two callers
  // that differ only in it must not share one entry.
  const key = `${input.sessionId}|${input.userId}|${input.callerSessionId ?? '-'}|${input.boundCredentialSessionId ?? '-'}`;
  const cached = sessionVisibilityCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.allowed;

  const [row] = await db
    .select({
      visibility: projectSessions.visibility,
      createdBy: projectSessions.createdBy,
      origin: projectSessions.origin,
      metadata: projectSessions.metadata,
    })
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
    const [subject, grantsBySession, managerVerdict] = await Promise.all([
      resolveShareSubject(input.userId),
      loadSessionGrants([input.sessionId]),
      isTriggerCreatedSessionMetadata(row.metadata)
        ? authorize(actorForUser(input.userId, input.accountId), 'project.members.manage', {
            type: 'project',
            id: input.projectId,
          })
        : Promise.resolve({ allowed: false as const, reason: 'not_trigger_session' }),
    ]);
    const grants = grantsBySession.get(input.sessionId) ?? [];
    allowed = isProjectSessionVisibleTo(
      row.visibility as 'private' | 'project' | 'restricted',
      row.createdBy,
      grants,
      subject,
      {
        origin: row.origin ?? null,
        sessionId: input.sessionId,
        callerSessionId: input.callerSessionId,
        boundCredentialSessionId: input.boundCredentialSessionId,
      },
      { metadata: row.metadata, canManageProject: managerVerdict.allowed },
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
 * Resolve the real session sandbox uuid + owning account/project from a
 * `previewSandboxId`, which can be either a uuid (sandboxId / externalId) or
 * the Daytona-side externalId string.
 */
async function resolveSandboxRef(
  previewSandboxId: string,
): Promise<{ sandboxId: string; accountId: string; projectId: string } | null> {
  const columns = {
    sandboxId: sessionSandboxes.sandboxId,
    accountId: sessionSandboxes.accountId,
    projectId: sessionSandboxes.projectId,
  };

  const idCondition = UUID_RE.test(previewSandboxId)
    ? or(
        eq(sessionSandboxes.externalId, previewSandboxId),
        eq(sessionSandboxes.sandboxId, previewSandboxId),
      )
    : eq(sessionSandboxes.externalId, previewSandboxId);

  const [row] = await db.select(columns).from(sessionSandboxes).where(idCondition).limit(1);
  if (row) return row;

  // Case-insensitive fallback — REQUIRED for subdomain previews.
  //
  // `external_id` is an uppercase ULID (`sbx_01KYCZ…`), but the subdomain form
  // `p{port}-{sandboxId}.{host}` carries it in a HOSTNAME, and hostnames are
  // case-insensitive: the browser lowercases them before the Host header is
  // ever sent, so the proxy can only ever see `sbx_01kycz…`. An exact `eq`
  // therefore never matched and every subdomain preview 401'd with
  // `{"error":"Unauthorized"}`, while the path-based `/v1/p/{id}/{port}` route
  // — whose id lives in a case-PRESERVING path segment — worked fine. That
  // asymmetry is what made this look like a token bug rather than a lookup bug.
  //
  // The exact match above stays the indexed fast path; this only runs on a miss,
  // and the result is cached by `getOrCompute`.
  const [ciRow] = await db
    .select(columns)
    .from(sessionSandboxes)
    .where(sql`lower(${sessionSandboxes.externalId}) = lower(${previewSandboxId})`)
    .limit(1);

  if (ciRow) return ciRow;

  const environmentColumns = {
    sandboxId: sql<string>`coalesce(${sessionEnvironments.metadata}->>'environmentId', ${sessionEnvironments.sessionId})`,
    accountId: sessionEnvironments.accountId,
    projectId: sessionEnvironments.projectId,
  };
  const environmentCondition = UUID_RE.test(previewSandboxId)
    ? or(
        eq(sessionEnvironments.externalId, previewSandboxId),
        sql`${sessionEnvironments.metadata}->>'environmentId' = ${previewSandboxId}`,
      )
    : eq(sessionEnvironments.externalId, previewSandboxId);
  const [environment] = await db
    .select(environmentColumns)
    .from(sessionEnvironments)
    .where(environmentCondition)
    .limit(1);
  if (environment) return environment;

  const [ciEnvironment] = await db
    .select(environmentColumns)
    .from(sessionEnvironments)
    .where(sql`lower(${sessionEnvironments.externalId}) = lower(${previewSandboxId})`)
    .limit(1);
  return ciEnvironment ?? null;
}

/**
 * Resolve the project a sandbox belongs to, given the same `previewSandboxId`
 * form the proxy path carries (uuid or Daytona externalId). Used by the
 * project-scoped-PAT gate in middleware/auth.ts to decide whether a project
 * PAT may reach `/v1/p/{sandboxId}/...` — it may, only for a sandbox whose
 * `session_sandboxes.project_id` matches the token's own project. One indexed
 * lookup (sandbox_id is the PK; external_id and project_id are both indexed),
 * so this is cheap enough for the auth hot path. Returns null when the
 * sandbox row can't be found — callers must treat that as "deny", not
 * "unscoped ok".
 */
export async function resolveSandboxProjectId(previewSandboxId: string): Promise<string | null> {
  const ref = await resolveSandboxRef(previewSandboxId);
  return ref?.projectId ?? null;
}

async function isAccountMember(userId: string, accountId: string): Promise<boolean> {
  const [row] = await db
    .select({ accountId: accountMembers.accountId })
    .from(accountMembers)
    .where(and(eq(accountMembers.userId, userId), eq(accountMembers.accountId, accountId)))
    .limit(1);
  return !!row;
}

async function computeEntry(previewSandboxId: string, userId: string): Promise<CacheEntry> {
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

async function getOrCompute(previewSandboxId: string, userId: string): Promise<CacheEntry> {
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
