import { isSessionVisibleTo, loadSessionGrants, resolveShareSubject, type SecretGrant, type ShareSubject } from '../../executor/share';
import { authorize, assertAuthorized } from '../../iam';
import { deriveRequestContext } from '../../iam/cache';
import { invalidateIamCacheForUser, registerPrincipalScopedMemo } from '../../iam/cache-invalidation';
import { auth } from '../../openapi';
import { notePoolPresence } from '../../platform/services/warm-pool';
import { preResumeRecentStoppedSessions } from '../routes/shared';
import { db } from '../../shared/db';
import { resolveAccountId } from '../../shared/resolve-account';
import { getSupabase } from '../../shared/supabase';
import { ttlMemo } from '../../shared/ttl-memo';
import { effectiveProjectRole, roleAllows, type AccountRole, type ProjectAccessAction, type ProjectRole } from '../access';
import { accountMembers, projectMembers, projectSessions, projects } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { maxProjectsForAccount } from '../../shared/account-limits';
import { getAccountMembership } from './git';
import { ProjectRow, ProjectSessionRow, normalizeString } from './serializers';

// Enforce the per-account project cap (free → 1, paid → effectively uncapped).
// Returns a 403 Response to send, or null when the account may create another
// project. `repoUrl`, when supplied, makes re-linking a repo the account already
// owns idempotent — that's an update, not a new project, so it never trips the
// limit even when the account is at its cap.
export async function enforceProjectQuota(
  c: Context,
  accountId: string,
  opts?: { repoUrl?: string | null },
): Promise<Response | null> {
  const limit = await maxProjectsForAccount(accountId);
  if (limit >= Number.MAX_SAFE_INTEGER) return null;

  if (opts?.repoUrl) {
    const [existing] = await db
      .select({ projectId: projects.projectId })
      .from(projects)
      .where(and(eq(projects.accountId, accountId), eq(projects.repoUrl, opts.repoUrl)))
      .limit(1);
    if (existing) return null;
  }

  // Count only ACTIVE projects — an archived (soft-deleted) project must not
  // permanently consume a free account's single slot.
  const [counted] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(projects)
    .where(and(eq(projects.accountId, accountId), eq(projects.status, 'active')));
  const count = counted?.count ?? 0;
  if (count >= limit) {
    return c.json(
      {
        error:
          limit === 1
            ? 'Free accounts are limited to 1 project. Upgrade to a paid plan to create more.'
            : `This account has reached its limit of ${limit} projects.`,
        code: 'project_limit_reached',
        limit,
        count,
      },
      403,
    );
  }
  return null;
}

export async function loadVisibleSession(
  loaded: { row: ProjectRow; userId: string; effectiveRole: ProjectRole },
  sessionId: string,
): Promise<{
  row: ProjectSessionRow;
  subject: ShareSubject;
  grants: SecretGrant[];
  isOwner: boolean;
  canManageProject: boolean;
  canManageSharing: boolean;
} | null> {
  const [row] = await db
    .select()
    .from(projectSessions)
    .where(and(
      eq(projectSessions.sessionId, sessionId),
      eq(projectSessions.projectId, loaded.row.projectId),
      eq(projectSessions.accountId, loaded.row.accountId),
    ))
    .limit(1);
  if (!row) return null;
  const subject = await resolveShareSubject(loaded.userId);
  const grants = (await loadSessionGrants([sessionId])).get(sessionId) ?? [];
  if (!isSessionVisibleTo(row.visibility as 'private' | 'project' | 'restricted', row.createdBy, grants, subject)) {
    return null;
  }
  const isOwner = row.createdBy === loaded.userId;
  const canManageProject = roleAllows(loaded.effectiveRole, 'manage');
  return { row, subject, grants, isOwner, canManageProject, canManageSharing: isOwner || canManageProject };
}


// Memoized briefly (positive hits only) — same rationale and trade-off as
// getAccountMembership: runs on every project request, cross-region roundtrip
// per statement, revocations lag at most one TTL window, grants are instant.
const loadProjectMemberRole = ttlMemo({
  ttlMs: 15_000,
  // Key is `${userId}|${projectId}` (userId-first) so a single
  // invalidateByPrefix(`${userId}|`) busts it alongside the engine memos.
  keyFn: (projectId: string, userId: string) => `${userId}|${projectId}`,
  loader: async (projectId: string, userId: string): Promise<ProjectRole | null> => {
    const [row] = await db
      .select({ projectRole: projectMembers.projectRole })
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
      .limit(1);
    return (row?.projectRole as ProjectRole | undefined) ?? null;
  },
  shouldCache: (role) => role !== null,
});
registerPrincipalScopedMemo(loadProjectMemberRole);

export async function getProjectMemberRole(projectId: string, userId: string): Promise<ProjectRole | null> {
  return loadProjectMemberRole(projectId, userId);
}


export async function grantProjectRole(input: {
  accountId: string;
  projectId: string;
  userId: string;
  role: ProjectRole;
  grantedBy: string;
  /** undefined = leave as-is on update / NULL on insert; null = clear
   *  any existing expiry; Date = set/replace the expiry. */
  expiresAt?: Date | null | undefined;
}) {
  const now = new Date();
  await db
    .insert(projectMembers)
    .values({
      accountId: input.accountId,
      projectId: input.projectId,
      userId: input.userId,
      projectRole: input.role,
      grantedBy: input.grantedBy,
      expiresAt: input.expiresAt ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [projectMembers.projectId, projectMembers.userId],
      set: {
        projectRole: input.role,
        grantedBy: input.grantedBy,
        updatedAt: now,
        // Only overwrite expires_at when the caller explicitly supplied
        // it (undefined preserves the existing value).
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      },
    });
  // The role just changed — drop this user's cached authz so the new role is
  // effective on their next request, not after the ~15s TTL window.
  invalidateIamCacheForUser(input.userId);
}

/**
 * Parse + validate an optional `expires_at` ISO string from a request
 * body. undefined = caller didn't set; null = clear; Date = set.
 * Rejects past timestamps to surface mistakes at write time.
 */

export function parseExpiresAtBody(
  raw: unknown,
): { ok: true; value: Date | null | undefined } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string')
    return { ok: false, error: 'expires_at must be an ISO-8601 string or null' };
  const d = new Date(raw);
  if (Number.isNaN(d.getTime()))
    return { ok: false, error: 'expires_at must be a valid ISO-8601 timestamp' };
  if (d.getTime() < Date.now())
    return { ok: false, error: 'expires_at must be in the future' };
  return { ok: true, value: d };
}


export async function ensureOrgMembership(
  accountId: string,
  userId: string,
): Promise<AccountRole> {
  const existing = await getAccountMembership(userId, accountId);
  if (existing) return existing.accountRole as AccountRole;
  await db
    .insert(accountMembers)
    .values({ userId, accountId, accountRole: 'member' })
    .onConflictDoNothing();
  return 'member';
}


export async function lookupEmailsByUserIds(userIds: string[]): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  if (userIds.length === 0) return result;
  const supabase = getSupabase();
  await Promise.all(
    userIds.map(async (uid) => {
      try {
        const { data } = await supabase.auth.admin.getUserById(uid);
        result.set(uid, data?.user?.email ?? null);
      } catch {
        result.set(uid, null);
      }
    }),
  );
  return result;
}


export async function resolveProjectAccount(c: Context, body?: Record<string, unknown>) {
  const userId = c.get('userId') as string;
  const requested = normalizeString(
    c.req.query('account_id') ??
    c.req.query('accountId') ??
    body?.account_id ??
    body?.accountId,
  );
  const accountId = requested ?? await resolveAccountId(userId);

  const membership = await getAccountMembership(userId, accountId);
  if (!membership) {
    throw new HTTPException(403, { message: 'You do not have access to this account' });
  }
  (c as any).set('accountId', membership.accountId);

  return {
    userId,
    accountId: membership.accountId,
    accountRole: membership.accountRole as AccountRole,
  };
}

// Maps the high-level project access action onto the IAM action key
// the engine recognises. Keep this narrow — these three labels cover
// every gate this file uses; bespoke actions (project.trigger.fire,
// project.deploy, project.secrets.write, etc.) should call authorize()
// directly with the exact action.

export function iamActionForProjectAccess(action: ProjectAccessAction): string {
  switch (action) {
    case 'read':
      return 'project.read';
    case 'write':
      return 'project.write';
    case 'manage':
      // 'manage' historically meant "admin-tier write" — covers triggers,
      // secrets, snapshots, CLI tokens, etc. Map to project.write (which
      // Project Editor has) so editors aren't accidentally locked out.
      // Routes that need the stricter `project.members.manage` gate add
      // an explicit assertProjectCapability() on top of loadProjectForUser.
      return 'project.write';
  }
}

/**
 * Assert a SPECIFIC project capability (a leaf action like project.gitops.push)
 * for the current request, threading the acting token id off the request context
 * so the engine's agent-grant fold actually fires — `userRole ∩ agentGrant`. Use
 * this (not a bare `assertAuthorized`) for every per-capability route gate: a
 * bare call omits the token and the fold silently no-ops, which is exactly how
 * the per-route checks leaked the agent grant. 403s on denial.
 */
export async function assertProjectCapability(
  c: Context,
  userId: string,
  accountId: string,
  projectId: string,
  action: string,
  // Optional per-RESOURCE narrowing: when supplied, the verdict is additionally
  // intersected with iam_resource_grants for this specific agent/skill (see
  // resource-grants.ts). Used by the agent/skill launch gates.
  resource?: { type: 'agent' | 'skill'; id: string },
): Promise<void> {
  const actingTokenId =
    ((c as unknown as { get(k: string): unknown }).get('iamTokenId') as string | undefined) ?? undefined;
  await assertAuthorized(
    userId,
    accountId,
    action,
    { type: 'project', id: projectId, ...(resource ? { resource } : {}) },
    actingTokenId,
    deriveRequestContext(c),
  );
}


// `projects.project_id` is a Postgres `uuid` column, so a malformed id
// (e.g. a truncated "fda4e35e") makes the lookup throw `invalid input syntax
// for type uuid` (SQLSTATE 22P02) before any guard runs — surfacing as an
// opaque 500. Validate the shape first so a bad id is a clean 404, not a 500.
const PROJECT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return PROJECT_ID_RE.test(value);
}

export async function loadProjectForUser(c: Context, projectId: string, action: ProjectAccessAction) {
  const userId = c.get('userId') as string;
  if (!isUuid(projectId)) return null;
  const [row] = await db
    .select()
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);
  if (!row || row.status === 'archived') return null;

  const actingTokenId =
    ((c as unknown as { get(k: string): unknown }).get('iamTokenId') as
      | string
      | undefined) ?? undefined;
  const requestCtx = deriveRequestContext(c);

  // Membership, project role and the IAM verdict are independent lookups —
  // overlap them. Every project-scoped request runs this path and each DB
  // statement costs a cross-region roundtrip in prod, so depth matters.
  // The engine consults super-admin bypass, direct + group policies,
  // project_groups, AND the legacy account_role / project_members bridges
  // (in non-strict mode), so it's strictly a superset of the old role-only
  // check. Passing requestCtx is required for IP-allowlist / require-MFA
  // policy conditions to evaluate against the current request.
  const [membership, projectRole, verdict] = await Promise.all([
    getAccountMembership(userId, row.accountId),
    getProjectMemberRole(projectId, userId),
    authorize(
      userId,
      row.accountId,
      iamActionForProjectAccess(action),
      { type: 'project', id: projectId },
      actingTokenId,
      requestCtx,
    ),
  ]);

  // A service account has NO account_members row — its access is purely its own
  // iam_policies, already evaluated by the engine `verdict` above. Don't apply
  // the human membership hard-gate to it (that would 403 every SA before its
  // standing role is ever consulted); fall through to the verdict check.
  const isServiceAccount = ((c as unknown as { get(k: string): unknown }).get('authType') as string | undefined) === 'service_account';
  if (!membership && !isServiceAccount) {
    throw new HTTPException(403, { message: 'You do not have access to this account' });
  }

  const accountRole = membership?.accountRole as AccountRole | undefined;
  if (!verdict.allowed) {
    // Distinguish "no access at all" from "has access but not for this
    // action" so the UI can show a meaningful message. A Viewer can see
    // the project but can't create a session — telling them "no access"
    // is misleading and they spend time wondering why they can see the
    // page at all. Only do the second probe when the failed action was
    // NOT already 'read' — otherwise it's the same answer.
    if (action !== 'read') {
      const readVerdict = await authorize(
        userId,
        row.accountId,
        'project.read',
        { type: 'project', id: projectId },
        actingTokenId,
        requestCtx,
      );
      if (readVerdict.allowed) {
        const verb = action === 'manage' ? 'manage this project' : 'change this project';
        throw new HTTPException(403, {
          message: `Your role on this project doesn't let you ${verb}. Ask a project Manager to grant you a higher role.`,
        });
      }
    }
    throw new HTTPException(403, { message: 'You do not have access to this project' });
  }

  // effectiveRole label for the UI / downstream helpers. The engine
  // doesn't hand back a role — it answers yes/no. Mirror the prior
  // mapping so any code reading effectiveRole still gets sensible
  // labels: owner/admin → manager, explicit project_members row →
  // that role, otherwise → 'viewer' (the engine permitted read but
  // we don't know the exact tier).
  // For a service account there's no account role; capabilities come purely from
  // its policies (already enforced by `verdict`). Use the safe-minimum 'viewer'
  // label, exactly as for a member granted access via a policy with no role tier.
  const effectiveRole =
    (accountRole ? effectiveProjectRole(accountRole, projectRole) : projectRole) ?? 'viewer';
  (c as any).set('accountId', row.accountId);

  // Presence signal for the warm pool: an authenticated user touching the
  // project (loading it, polling its sessions) means they're around and likely
  // to start a session — keep a warm box ready. No-op unless the pool is on;
  // throttled internally. Only members who can launch sessions count.
  // Skip on the explicit leave beacon: the user is LEAVING the project, so
  // recording presence (would re-arm a spare) or pre-resuming a session there is
  // exactly backwards — the leave handler drops presence + reaps instead.
  const isLeaveBeacon = !!(c as any).req?.path?.endsWith?.('/presence/leave');
  if (!isLeaveBeacon && (action !== 'read' || roleAllows(effectiveRole as ProjectRole, 'write'))) {
    notePoolPresence(projectId, row.accountId);
    // Same presence signal drives pre-resume: proactively wake the user's most
    // recently-stopped session(s) so the resume overlaps their navigation.
    // No-op unless KORTIX_PRERESUME_ENABLED; throttled + idempotent internally.
    preResumeRecentStoppedSessions(projectId, userId);
  }

  return {
    row,
    userId,
    accountRole: accountRole ?? null,
    projectRole,
    effectiveRole: effectiveRole as ProjectRole,
  };
}

// Env names a project secret must NEVER inject into a sandbox — they belong to
// the sandbox's own runtime (the OS, the daemon, opencode). A secret named e.g.
// `PORT` (trivially pushed via `kortix env push --from a-server.env`) would
// override the runtime and break every session. Anything `KORTIX_*`/`OPENCODE_*`
// is platform-owned and set explicitly below.
