import { isSessionVisibleTo, loadSessionGrants, resolveShareSubject, type SecretGrant, type ShareSubject } from '../../executor/share';
import { authorize, assertAuthorized, PROJECT_ACTIONS } from '../../iam';
import { deriveRequestContext } from '../../iam/cache';
import { invalidateIamCacheForUser, registerPrincipalScopedMemo } from '../../iam/cache-invalidation';
import { auth } from '../../openapi';
import { preResumeRecentStoppedSessions } from '../routes/shared';
import { recordAuditEvent } from '../../shared/audit';
import { db } from '../../shared/db';
import { isPlatformAdmin } from '../../shared/platform-roles';
import { resolveAccountId } from '../../shared/resolve-account';
import { getSupabase } from '../../shared/supabase';
import { ttlMemo } from '../../shared/ttl-memo';
import { effectiveProjectRole, roleAllows, type AccountRole, type ProjectAccessAction, type ProjectRole } from '../access';
import { accountMembers, accountUser, accounts, projectMembers, projectSessions, projects } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { FREE_TIER_PROJECT_LIMIT, maxProjectsForAccount } from '../../shared/account-limits';
import { getAccountMembership } from './git';
import { ProjectRow, ProjectSessionRow, normalizeString } from './serializers';

// Enforce the per-account project cap (free → 3, paid → effectively uncapped).
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
          limit === FREE_TIER_PROJECT_LIMIT
            ? `Free accounts are limited to ${limit} projects. Upgrade to a paid plan to create more.`
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

async function loadProjectSessionRow(
  loaded: { row: ProjectRow },
  sessionId: string,
): Promise<ProjectSessionRow | null> {
  const [row] = await db
    .select()
    .from(projectSessions)
    .where(and(
      eq(projectSessions.sessionId, sessionId),
      eq(projectSessions.projectId, loaded.row.projectId),
      eq(projectSessions.accountId, loaded.row.accountId),
    ))
    .limit(1);
  return row ?? null;
}

export async function loadVisibleSession(
  loaded: { row: ProjectRow; userId: string; effectiveRole: ProjectRole; adminBypass?: boolean },
  sessionId: string,
): Promise<{
  row: ProjectSessionRow;
  subject: ShareSubject;
  grants: SecretGrant[];
  isOwner: boolean;
  canManageProject: boolean;
  canManageSharing: boolean;
} | null> {
  const row = await loadProjectSessionRow(loaded, sessionId);
  if (!row) return null;
  const subject = await resolveShareSubject(loaded.userId);
  const grants = (await loadSessionGrants([sessionId])).get(sessionId) ?? [];
  if (!isSessionVisibleTo(row.visibility as 'private' | 'project' | 'restricted', row.createdBy, grants, subject)) {
    // A platform-admin bypass already verified for the parent project (see
    // loadProjectForUser) also covers a session that would otherwise be
    // invisible (private / not-my-grant). Audit every use — this is a real
    // support/investigation escape hatch, not a standing grant.
    if (!loaded.adminBypass) return null;
    await recordAuditEvent({
      accountId: loaded.row.accountId,
      actorUserId: loaded.userId,
      action: 'project.admin_bypass_session_read',
      resourceType: 'project_session',
      resourceId: sessionId,
      metadata: { via: 'admin_bypass_header', sessionVisibility: row.visibility },
    });
  }
  const isOwner = row.createdBy === loaded.userId;
  const canManageProject = roleAllows(loaded.effectiveRole, 'manage');
  return { row, subject, grants, isOwner, canManageProject, canManageSharing: isOwner || canManageProject };
}

/**
 * Load a session for SHARING-MANAGEMENT purposes (the public-shares CRUD
 * routes) — a narrower, distinct question from `loadVisibleSession`'s "can
 * this user read the session's content/transcript".
 *
 * Managing a session's public share links is a project-management action:
 * the session's creator always can, and a project manager/owner/admin can
 * too, REGARDLESS of the session's private-content `visibility`. Reusing
 * `loadVisibleSession` here was a bug — a private session (the default)
 * is invisible to everyone but its creator under `isSessionVisibleTo`, so
 * the `canManageProject` half of `canManageSharing` could never be reached:
 * the route always 404'd on the visibility gate first, even for a real
 * project manager. A project member with no manage rights (e.g. an editor
 * who didn't create the session) still gets a truthful 403 (permission
 * denied) here, not a 404 (resource hidden) — they're a legitimate member of
 * the project the session lives in, not a stranger, so there's nothing to
 * hide about the session's mere existence.
 */
export async function loadSessionForSharing(
  loaded: { row: ProjectRow; userId: string; effectiveRole: ProjectRole },
  sessionId: string,
): Promise<{
  row: ProjectSessionRow;
  isOwner: boolean;
  canManageProject: boolean;
  canManageSharing: boolean;
} | null> {
  const row = await loadProjectSessionRow(loaded, sessionId);
  if (!row) return null;
  const isOwner = row.createdBy === loaded.userId;
  const canManageProject = roleAllows(loaded.effectiveRole, 'manage');
  return { row, isOwner, canManageProject, canManageSharing: isOwner || canManageProject };
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

async function repairLegacyRequestedAccountMembership(userId: string, accountId: string) {
  try {
    const [legacy] = await db
      .select({ accountId: accountUser.accountId })
      .from(accountUser)
      .where(and(eq(accountUser.userId, userId), eq(accountUser.accountId, accountId)))
      .limit(1);
    if (!legacy) return null;

    await db
      .insert(accounts)
      .values({ accountId, name: 'Account' })
      .onConflictDoNothing();
    await db
      .insert(accountMembers)
      .values({
        userId,
        accountId,
        accountRole: 'owner',
        isSuperAdmin: true,
      })
      .onConflictDoNothing();

    return await getAccountMembership(userId, accountId);
  } catch (err) {
    console.warn('[projects] Failed to repair legacy account membership:', err);
    return null;
  }
}


export interface UserIdentity {
  /** Email from the auth provider, or null if the user has none. */
  email: string | null;
  /**
   * Whether this user_id resolves to a real auth user. `false` means the auth
   * provider returned NO user for this id — i.e. it's a shadow/orphan principal
   * (e.g. an `account_members` row whose user_id is actually an account_id with
   * no backing user). A transient lookup failure leaves this `true` so a hiccup
   * never hides a real member.
   */
  exists: boolean;
}

/**
 * Resolve user_ids to their auth identity (email + existence). Existence lets
 * callers drop "shadow" members — rows that point at a non-existent user, which
 * would otherwise render as a raw UUID in member lists.
 */
export async function resolveUserIdentities(userIds: string[]): Promise<Map<string, UserIdentity>> {
  const result = new Map<string, UserIdentity>();
  if (userIds.length === 0) return result;
  const supabase = getSupabase();
  await Promise.all(
    userIds.map(async (uid) => {
      try {
        const { data } = await supabase.auth.admin.getUserById(uid);
        // A completed call with no user object = the id is not a real user.
        const user = data?.user ?? null;
        result.set(uid, { email: user?.email ?? null, exists: !!user });
      } catch {
        // Transient (network/5xx) — assume the user exists; don't hide them.
        result.set(uid, { email: null, exists: true });
      }
    }),
  );
  return result;
}

export async function lookupEmailsByUserIds(userIds: string[]): Promise<Map<string, string | null>> {
  const identities = await resolveUserIdentities(userIds);
  const result = new Map<string, string | null>();
  for (const [uid, identity] of identities) result.set(uid, identity.email);
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

  const existingMembership = await getAccountMembership(userId, accountId);
  const membership =
    existingMembership ??
    (requested ? await repairLegacyRequestedAccountMembership(userId, accountId) : null);
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
    case 'session':
      // Starting / running / stopping a session. Granted to every project
      // role (a plain `member` included) so the floor role can actually use
      // Kortix, while project customization stays behind project.write.
      return 'project.session.start';
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

/**
 * The per-capability WRITE leaf that governs editing a given repo path. Agents,
 * skills and commands live under their own directories; everything else is a
 * generic project file. Lets an API edit path (e.g. a marketplace install) gate
 * each touched file on the RIGHT capability — so a custom role that omits
 * `project.skill.write` can't install/modify skills even though it can touch
 * other files.
 */
export function writeCapabilityForRepoPath(path: string): string {
  const segments = path.replace(/^\.?\//, '').split('/');
  if (segments.includes('agent') || segments.includes('agents')) return PROJECT_ACTIONS.PROJECT_AGENT_WRITE;
  if (segments.includes('skill') || segments.includes('skills')) return PROJECT_ACTIONS.PROJECT_SKILL_WRITE;
  if (segments.includes('command') || segments.includes('commands')) return PROJECT_ACTIONS.PROJECT_COMMAND_WRITE;
  return PROJECT_ACTIONS.PROJECT_FILE_WRITE;
}

/**
 * Gate an API-mediated commit on the per-capability write leaves of the files it
 * touches. A commit that adds an agent requires project.agent.write; one that
 * touches a skill + a generic file requires BOTH project.skill.write AND
 * project.file.write. Threads the acting token so the agent-grant fold fires.
 * (Raw `git push` and daemon-side session commits don't pass through here — that
 * whole-tree boundary is the git-proxy tier.)
 */
export async function assertCommitCapabilities(
  c: Context,
  userId: string,
  accountId: string,
  projectId: string,
  paths: readonly string[],
): Promise<void> {
  // Generated bookkeeping files ride along with every install/remove — they're
  // not a resource a role edits, so don't couple e.g. "install a skill" to also
  // needing project.file.write for the lock file.
  const BOOKKEEPING = new Set(['registry-lock.json', 'skills-lock.json']);
  const capabilities = new Set(
    paths
      .filter((p) => !BOOKKEEPING.has(p.replace(/^\.?\//, '').split('/').pop() ?? ''))
      .map(writeCapabilityForRepoPath),
  );
  for (const action of capabilities) {
    await assertProjectCapability(c, userId, accountId, projectId, action);
  }
}


// `projects.project_id` is a Postgres `uuid` column, so a malformed id
// (e.g. a truncated "fda4e35e") makes the lookup throw `invalid input syntax
// for type uuid` (SQLSTATE 22P02) before any guard runs — surfacing as an
// opaque 500. Validate the shape first so a bad id is a clean 404, not a 500.
const PROJECT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return PROJECT_ID_RE.test(value);
}

/**
 * The full platform-admin-bypass decision — pure (the DB/header lookups are
 * already resolved into `isPlatformAdmin`/`bypassHeaderPresent` by the
 * caller) so this security gate is exhaustively unit-tested independent of
 * the DB, mirroring the decideReap pattern in sandbox-reaper.ts. A bypass is
 * never eligible for anything but a read, and never for a service account
 * (those already carry their own iam_policies and shouldn't get a second,
 * broader door) — checked BEFORE `isPlatformAdmin` is even consulted by the
 * caller, so a non-admin's header never triggers a DB round-trip.
 */
export function shouldApplyAdminBypass(input: {
  action: ProjectAccessAction;
  isServiceAccount: boolean;
  bypassHeaderPresent: boolean;
  isPlatformAdmin: boolean;
}): boolean {
  return (
    isAdminBypassEligible(input) && input.isPlatformAdmin
  );
}

/** Whether a bypass request should even be CONSIDERED — i.e. whether it's
 *  worth spending a DB round-trip on `isPlatformAdmin` at all. */
export function isAdminBypassEligible(input: {
  action: ProjectAccessAction;
  isServiceAccount: boolean;
  bypassHeaderPresent: boolean;
}): boolean {
  return input.action === 'read' && !input.isServiceAccount && input.bypassHeaderPresent;
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

  // Platform-admin READ-ONLY bypass: an explicit `x-kortix-admin-bypass`
  // header from a real `platform_user_roles` admin/super_admin lets support
  // staff VIEW a project they have no account/project grant on — e.g. to
  // confirm a customer's session actually loads. Deliberately scoped to
  // action === 'read' only (never write/session/manage) so a bypass can
  // never be used to act as the account. Every use is audit-logged against
  // the PROJECT'S OWN account so the customer's own audit trail (and any
  // configured audit webhook) sees the access, not just ours.
  let adminBypass = false;
  const bypassHeaderPresent = c.req.header('x-kortix-admin-bypass') === '1';
  if (isAdminBypassEligible({ action, isServiceAccount, bypassHeaderPresent })) {
    adminBypass = shouldApplyAdminBypass({
      action,
      isServiceAccount,
      bypassHeaderPresent,
      isPlatformAdmin: await isPlatformAdmin(userId),
    });
    if (adminBypass) {
      await recordAuditEvent({
        accountId: row.accountId,
        actorUserId: userId,
        action: 'project.admin_bypass_read',
        resourceType: 'project',
        resourceId: projectId,
        metadata: { via: 'admin_bypass_header' },
      });
    }
  }

  if (!membership && !isServiceAccount && !adminBypass) {
    throw new HTTPException(403, { message: 'You do not have access to this account' });
  }

  const accountRole = membership?.accountRole as AccountRole | undefined;
  if (!verdict.allowed && !adminBypass) {
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
          message: `Your role on this project doesn't let you ${verb}. Ask an account owner or admin to grant you a higher role.`,
        });
      }
    }
    throw new HTTPException(403, { message: 'You do not have access to this project' });
  }

  // effectiveRole label for the UI / downstream helpers. The engine
  // doesn't hand back a role — it answers yes/no. Mirror the prior
  // mapping so any code reading effectiveRole still gets sensible
  // labels: owner/admin → manager, explicit project_members row →
  // that role, otherwise → 'member' (the engine permitted read but
  // we don't know the exact tier).
  // For a service account there's no account role; capabilities come purely from
  // its policies (already enforced by `verdict`). Use the safe-minimum 'member'
  // label, exactly as for a member granted access via a policy with no role tier.
  const effectiveRole =
    (accountRole ? effectiveProjectRole(accountRole, projectRole) : projectRole) ?? 'member';
  (c as any).set('accountId', row.accountId);

  if (action !== 'read' || roleAllows(effectiveRole as ProjectRole, 'write')) {
    // Proactively wake the user's most recently-stopped session(s) so the resume
    // overlaps their navigation. No-op unless KORTIX_PRERESUME_ENABLED.
    preResumeRecentStoppedSessions(projectId, userId);
  }

  return {
    row,
    userId,
    accountRole: accountRole ?? null,
    projectRole,
    effectiveRole: effectiveRole as ProjectRole,
    adminBypass,
  };
}

// Env names a project secret must NEVER inject into a sandbox — they belong to
// the sandbox's own runtime (the OS, the daemon, opencode). A secret named e.g.
// `PORT` (trivially pushed via `kortix env push --from a-server.env`) would
// override the runtime and break every session. Anything `KORTIX_*`/`OPENCODE_*`
// is platform-owned and set explicitly below.
