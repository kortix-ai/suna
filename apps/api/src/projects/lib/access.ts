import { normalizeProjectRole } from '../../iam/roles';
import {
  isSessionTargetVisibleToCaller,
  isProjectSessionVisibleTo,
  isTriggerCreatedSessionMetadata,
  loadSessionGrants,
  mayManageSessionSharing,
  resolveShareSubject,
  type SecretGrant,
  type ShareSubject,
} from '../../connectors/share';
// Straight from the engine + the actor builder, not the barrel: the barrel is
// replaced wholesale by `mock.module` in several route tests, so every name
// imported from it is a name those stubs must also declare.
import { authorize, assertAuthorized } from '../../iam/authorize';
import { actorOf, type Actor } from '../../iam/actor';
import { assignRole, SYSTEM_ACTOR } from '../../iam/assignments';
import { projectRoleForUser } from '../../iam/read-models';
// Straight from `iam/denial-message`, not the `iam` barrel: the barrel and the
// engine are both replaced wholesale by `mock.module` in several route tests,
// and these two names are pure wording policy with no reason to live behind
// that.
import { buildDenialError, denialReasonMessage } from '../../iam/denial-message';
import { invalidateIamCacheForUser, registerPrincipalScopedMemo } from '../../iam/cache-invalidation';
import { setContextField } from '../../lib/request-context';
import { auth } from '../../openapi';
import { recordAuditEvent } from '../../shared/audit';
import { db } from '../../shared/db';
import {
  IMPERSONATION_INVALID_CODE,
  impersonatedAccountFor,
} from '../../shared/impersonation';
import { isPlatformAdmin } from '../../shared/platform-roles';
import { resolveAccountId } from '../../shared/resolve-account';
import { getSupabase } from '../../shared/supabase';
import { ttlMemo } from '../../shared/ttl-memo';
import { effectiveProjectRole, roleAllows, type AccountRole, type ProjectAccessAction, type ProjectRole } from '../access';
import { accountMembers, accountMemberships, projectSessions, projects, serviceAccounts } from '@kortix/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { FREE_TIER_PROJECT_LIMIT, maxProjectsForAccount } from '../../shared/account-limits';
import { getAccountMembership } from './git';
import { ProjectRow, ProjectSessionRow, normalizeString } from './serializers';
import { mergeSessionOwnerIdentities, type SessionOwnerIdentity } from './session-inventory';
import {
  isRepositoryProjectAction,
  sessionWorkspaceAllowsRepositoryAccess,
} from './session-workspace-access';

// Enforce the per-account project cap (free → 1, paid → effectively uncapped).
// Returns a 403 Response to send, or null when the account may create another
// project. Every isolated project counts, even when another project uses the
// same Git repository or branch.
export async function enforceProjectQuota(
  c: Context,
  accountId: string,
): Promise<Response | null> {
  const limit = await maxProjectsForAccount(accountId);
  if (limit >= Number.MAX_SAFE_INTEGER) return null;

  // Count only ACTIVE projects — an archived (soft-deleted) project must not
  // permanently consume a free account's single slot.
  const [counted] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(projects)
    .where(and(eq(projects.accountId, accountId), eq(projects.status, 'active')));
  const count = counted?.count ?? 0;
  if (count >= limit) {
    // FREE_TIER_PROJECT_LIMIT is 1, so this string is pluralized rather than
    // hardcoded — "limited to 1 projects" reads as a bug to the user.
    const projectsWord = limit === 1 ? 'project' : 'projects';
    return c.json(
      {
        error:
          limit === FREE_TIER_PROJECT_LIMIT
            ? `Free accounts are limited to ${limit} ${projectsWord}. Upgrade to a paid plan to create more.`
            : `This account has reached its limit of ${limit} ${projectsWord}.`,
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

// Memoized like the membership/role loaders above, and for the same reason:
// every session read now asks this question, and the answer for one principal
// is identical across a burst of parallel requests. Positive AND negative
// results are cached — a service account never becomes a human, and a human
// never becomes a service account, so neither direction can go stale.
const loadPrincipalIsServiceAccount = ttlMemo({
  ttlMs: 60_000,
  keyFn: (accountId: string, principalId: string) => `${principalId}|${accountId}`,
  loader: async (accountId: string, principalId: string): Promise<boolean> => {
    const [row] = await db
      .select({ id: serviceAccounts.serviceAccountId })
      .from(serviceAccounts)
      .where(
        and(
          eq(serviceAccounts.accountId, accountId),
          eq(serviceAccounts.serviceAccountId, principalId),
        ),
      )
      .limit(1);
    return Boolean(row);
  },
});

/**
 * Is the machine-owner lookup capable of changing the verdict?
 *
 * `mayManageSessionSharing` is `isOwner || (canManageProject && ownerIsMachine)`.
 * The owner short-circuits it, and a caller with no manage role can never reach
 * the second term — so in both cases the answer is already decided and the
 * query is pure cost. `loadVisibleSession` runs on most session routes, and the
 * overwhelmingly common caller is a user reading their OWN session, so skipping
 * it there keeps this change off the hot path entirely.
 *
 * The `false` reported in the skipped cases is never read as a fact about the
 * session: its one consumer is the predicate above, which discards it.
 */
function ownerIsMachineCanMatter(isOwner: boolean, canManageProject: boolean): boolean {
  return !isOwner && canManageProject;
}

/**
 * Does this session have a MACHINE owner rather than a human one?
 *
 * True when `created_by` is empty, or names a service account of this account —
 * the identity every trigger/agent run is stamped with. It is the one case
 * where a project manager governs sharing, because no human is there to.
 *
 * Deliberately a POSITIVE test for "is a service account" and not a negative
 * test for "is an account member": a lookup failure, a removed user, or a stale
 * principal all answer `false` and keep the session owner-only. Denying a
 * manager is recoverable; widening a private session is not.
 */
export async function sessionOwnerIsMachine(
  accountId: string,
  createdBy: string | null,
): Promise<boolean> {
  if (!createdBy) return true;
  return loadPrincipalIsServiceAccount(accountId, createdBy);
}

/**
 * Does this caller carry its user's project-management standing?
 *
 * A session-bound AGENT credential does not: it acts for one session, so it
 * must not inherit the launching user's `manage` role and, through it, the
 * trigger-session override that would expose sibling sessions.
 *
 * Keyed on the AGENT binding, never on `callerSessionId`. That field holds the
 * SUPABASE LOGIN session id for every signed-in human (middleware/auth.ts:285,
 * :341), so keying on it would strip managers of `canManageProject` — and with
 * it `canManageLifecycle` — producing a 403 on stop, restart, delete and
 * change-model for every manager who is not the owner.
 *
 * Pure and exported for unit tests, like shouldApplyAdminBypass above.
 */
export function callerHasManagerStanding(
  effectiveRole: ProjectRole,
  boundCredentialSessionId: string | null,
): boolean {
  return boundCredentialSessionId === null && roleAllows(effectiveRole, 'manage');
}

export async function loadVisibleSession(
  loaded: {
    row: ProjectRow;
    userId: string;
    effectiveRole: ProjectRole;
    adminBypass?: boolean;
    /** The request's canonical principal. Absent only in tests that build a
     *  `loaded` shape by hand; the members.manage probe below then declines
     *  rather than widening. */
    actor?: Actor | null;
  },
  sessionId: string,
  /**
   * The CALLER's own session, when the credential is bound to one (a sandbox
   * token: `c.get('sessionId')`). Null/undefined for a human or for a wrapper's
   * own backend credential. Required to stop a sandbox reaching a SIBLING
   * backend session — every KaaB session shares one `created_by`, so ownership
   * alone cannot separate them. See isSessionVisibleTo.
   */
  callerSessionId: string | null,
  /**
   * The caller's AGENT/SANDBOX token binding — always `callerKortixSessionId(c)`.
   *
   * Separate from `callerSessionId` on purpose. 14 of this function's call sites
   * pass the RAW `c.get('sessionId')` for that one, and `resolveSupabaseAuth`
   * (middleware/auth.ts:285, :341) sets it to the SUPABASE LOGIN session id for
   * every signed-in human — so it cannot be read as "an agent token".
   * ONLY the trigger-session manager override reads this field.
   */
  boundCredentialSessionId: string | null,
): Promise<{
  row: ProjectSessionRow;
  subject: ShareSubject;
  grants: SecretGrant[];
  isOwner: boolean;
  canManageProject: boolean;
  /** Stop / restart / delete / model — manager-tier, unchanged. */
  canManageLifecycle: boolean;
  /** Who may open the session — owner-governed. See mayManageSessionSharing. */
  canManageSharing: boolean;
  /** True when `created_by` names a service account (or nobody). */
  ownerIsMachine: boolean;
} | null> {
  const row = await loadProjectSessionRow(loaded, sessionId);
  if (!row) return null;
  const subject = await resolveShareSubject(loaded.userId);
  const grants = (await loadSessionGrants([sessionId])).get(sessionId) ?? [];
  const ownership = {
    origin: row.origin ?? null,
    sessionId,
    callerSessionId,
    boundCredentialSessionId,
  };
  let canManageProject = callerHasManagerStanding(loaded.effectiveRole, boundCredentialSessionId);
  if (
    !canManageProject &&
    boundCredentialSessionId === null &&
    isSessionTargetVisibleToCaller(ownership) &&
    isTriggerCreatedSessionMetadata(row.metadata)
  ) {
    canManageProject = loaded.actor
      ? (
          await authorize(loaded.actor, 'project.members.manage', {
            type: 'project',
            id: loaded.row.projectId,
          })
        ).allowed
      : false;
  }
  if (
    !isProjectSessionVisibleTo(
      row.visibility as 'private' | 'project' | 'restricted',
      row.createdBy,
      grants,
      subject,
      ownership,
      { metadata: row.metadata, canManageProject },
    )
  ) {
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
  const ownerIsMachine = ownerIsMachineCanMatter(isOwner, canManageProject)
    ? await sessionOwnerIsMachine(loaded.row.accountId, row.createdBy)
    : false;
  return {
    row,
    subject,
    grants,
    isOwner,
    canManageProject,
    canManageLifecycle: isOwner || canManageProject,
    canManageSharing: mayManageSessionSharing({ isOwner, canManageProject, ownerIsMachine }),
    ownerIsMachine,
  };
}

/**
 * Load a session for PUBLIC-SHARE management — a distinct question from
 * `loadVisibleSession`'s "can this user read the session's content".
 *
 * Deliberately skips the content-visibility gate. Reusing `loadVisibleSession`
 * here was a bug: a private session (the default) is invisible to everyone but
 * its creator, so the route 404'd before any permission check ran, even for a
 * real project manager. A project member with no manage rights still gets a
 * truthful 403 (permission denied) here, not a 404 (resource hidden) — they
 * are a legitimate member of the project the session lives in, not a stranger.
 *
 * Two verdicts come back, and the routes must not confuse them:
 *
 *  - `canManageLifecycle` (owner OR manager) lists and REVOKES share links.
 *    Revoking only ever removes access, so a manager killing a leak on a
 *    session they cannot read is exactly the operation you want available.
 *  - `canManageSharing` (see mayManageSessionSharing) MINTS them. A public
 *    share link is unauthenticated, so a manager minting one against a private
 *    session they cannot read would hand themselves the content the visibility
 *    gate denied them — the same escalation the member-sharing rule closes.
 */
export async function loadSessionForSharing(
  loaded: { row: ProjectRow; userId: string; effectiveRole: ProjectRole },
  sessionId: string,
  /**
   * The CALLER's own session when the credential is bound to one. REQUIRED —
   * see loadVisibleSession. Sharing is the worst surface to leave unnarrowed:
   * a public share is UNAUTHENTICATED and its router is mounted before auth,
   * so minting one against another end-user's session exposes their live app
   * port and workspace files to anyone holding the URL.
   */
  callerSessionId: string | null,
): Promise<{
  row: ProjectSessionRow;
  isOwner: boolean;
  canManageProject: boolean;
  /** List + revoke a public share — manager-tier: revoking only ever removes access. */
  canManageLifecycle: boolean;
  /** MINT a public share — owner-governed, same rule as member sharing. */
  canManageSharing: boolean;
  ownerIsMachine: boolean;
} | null> {
  const row = await loadProjectSessionRow(loaded, sessionId);
  if (!row) return null;
  // Apply only the session-bound KaaB narrowing here. Human project members
  // must reach the sharing permission check and receive 403 when it rejects
  // them. Session-content visibility does not govern share management.
  if (!isSessionTargetVisibleToCaller({
    origin: row.origin ?? null,
    sessionId,
    callerSessionId,
  })) {
    return null;
  }
  const isOwner = row.createdBy === loaded.userId;
  const canManageProject = roleAllows(loaded.effectiveRole, 'manage');
  const ownerIsMachine = ownerIsMachineCanMatter(isOwner, canManageProject)
    ? await sessionOwnerIsMachine(loaded.row.accountId, row.createdBy)
    : false;
  return {
    row,
    isOwner,
    canManageProject,
    canManageLifecycle: isOwner || canManageProject,
    canManageSharing: mayManageSessionSharing({ isOwner, canManageProject, ownerIsMachine }),
    ownerIsMachine,
  };
}


// Memoized briefly (positive hits only) — same rationale and trade-off as
// getAccountMembership: runs on every project request. Each statement is a
// fast same-region roundtrip (~3ms measured, not the cross-region cost this
// comment used to claim), but the same query repeats across a burst of
// parallel requests, so caching still cuts redundant query volume;
// revocations lag at most one TTL window, grants are instant.
const loadProjectMemberRole = ttlMemo({
  ttlMs: 15_000,
  // Key is `${userId}|${projectId}` (userId-first) so a single
  // invalidateByPrefix(`${userId}|`) busts it alongside the engine memos.
  keyFn: (projectId: string, userId: string) => `${userId}|${projectId}`,
  loader: async (projectId: string, userId: string): Promise<ProjectRole | null> => {
    // From `role_assignments`, the store the verdict beside this label comes
    // from. `project_members` is no longer written by every path — an
    // assignment made through `assignRole()` leaves it untouched on purpose —
    // so a label read from it can disagree with the gate that just ran.
    return (await projectRoleForUser(projectId, userId)) as ProjectRole | null;
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
  // THE write. `kortix.project_members` is a view over `kortix.role_assignments`
  // as of the cutover, so there is no second store to keep in step and no
  // best-effort fallback: if this throws, no grant was made, and the caller must
  // hear about it.
  //
  // `SYSTEM_ACTOR` because the CALLER was already authorized by the route that
  // got here (`project.members.manage`, asserted before this function is
  // reached) — re-authorizing a different action here would 403 the
  // invite-acceptance and access-request-approval paths, where the writer is the
  // invitee or an approver acting on someone else's behalf.
  await assignRole(SYSTEM_ACTOR, input.accountId, {
    principal: { type: 'user', id: input.userId },
    roleKey: input.role,
    scope: { type: 'project', id: input.projectId },
    // undefined preserves nothing here: `assignRole` upserts expires_at
    // unconditionally, and every caller that means "leave it alone" already
    // reads the row first. null is "no expiry", which is the legacy INSERT's
    // default and what the three callers that omit it intend.
    expiresAt: input.expiresAt ?? null,
    source: 'manual',
    // The legacy `project_members` PRIMARY KEY (project_id, user_id) meant an
    // upsert REPLACED the role. Reproduce that: member -> manager must retract
    // the member row, not union with it.
    exclusive: true,
    // The human who granted it. `SYSTEM_ACTOR` only says "this route already
    // authorized the writer"; it does not mean nobody granted this.
    grantedBy: input.grantedBy,
  });
  // The role just changed — drop this user's cached authz so the new role is
  // effective on their next request, not after the ~15s TTL window.
  // (`assignRole` busts the principal memos; this covers the project-role label
  // memo in this module, which is keyed the same way.)
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
  // Membership is two facts in two stores now. IDENTITY (the row that says this
  // user belongs to this account, and carries is_super_admin / scim_external_id)
  // is `kortix.account_memberships`; the ROLE is an account-scope assignment.
  // Writing the identity row first is what lets `assignRole`'s principal check
  // resolve without falling back to auth.users.
  await db
    .insert(accountMemberships)
    .values({ userId, accountId })
    .onConflictDoNothing();
  // The grant, through the ONE write path, so joining an account emits
  // `iam.assignment.granted` like every other grant. `SYSTEM_ACTOR`: the two
  // callers (accepting a project invite, approving an access request) were
  // authorized by their own route, and the person being added is not the writer.
  await assignRole(SYSTEM_ACTOR, accountId, {
    principal: { type: 'user', id: userId },
    roleKey: 'member',
    scope: { type: 'account' },
    source: 'system',
    // One account role per member, as the `account_role` COLUMN enforced.
    exclusive: true,
  });
  invalidateIamCacheForUser(userId);
  return 'member';
}

export interface UserIdentity {
  /** Email from the auth provider, or null if the user has none. */
  email: string | null;
  /** Best available display name from auth metadata. */
  displayName: string | null;
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
        const metadata = user?.user_metadata as Record<string, unknown> | undefined;
        const displayName =
          typeof metadata?.name === 'string'
            ? metadata.name
            : typeof metadata?.full_name === 'string'
              ? metadata.full_name
              : null;
        result.set(uid, { email: user?.email ?? null, displayName, exists: !!user });
      } catch {
        // Transient (network/5xx) — assume the user exists; don't hide them.
        result.set(uid, { email: null, displayName: null, exists: true });
      }
    }),
  );
  return result;
}

export async function resolveSessionOwnerIdentities(
  ownerIds: string[],
  accountId: string,
): Promise<Map<string, SessionOwnerIdentity>> {
  const uniqueOwnerIds = [...new Set(ownerIds)];
  if (uniqueOwnerIds.length === 0) return new Map();

  const users = await resolveUserIdentities(uniqueOwnerIds);
  const unresolvedIds = uniqueOwnerIds.filter((ownerId) => !users.get(ownerId)?.exists);
  const machineIdentities = unresolvedIds.length
    ? await db
        .select({
          serviceAccountId: serviceAccounts.serviceAccountId,
          name: serviceAccounts.name,
          agentName: serviceAccounts.agentName,
        })
        .from(serviceAccounts)
        .where(
          and(
            eq(serviceAccounts.accountId, accountId),
            inArray(serviceAccounts.serviceAccountId, unresolvedIds),
          ),
        )
    : [];

  return mergeSessionOwnerIdentities({
    ownerIds: uniqueOwnerIds,
    users,
    serviceAccounts: machineIdentities,
  });
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
  // ACT-AS: the grant, not the query string, decides the account. Defense in
  // depth — under impersonation `/v1/accounts` returns only the target, so a
  // correct client already sends the target id. A stale one that still holds
  // the operator's OWN account id would otherwise resolve a real membership
  // here and write to the operator's account while the banner named the
  // customer's. Refuse instead.
  const impersonated = impersonatedAccountFor(userId);
  if (impersonated && requested && requested !== impersonated) {
    throw new HTTPException(403, {
      message: 'Impersonated requests cannot target another account',
      res: new Response(
        JSON.stringify({
          error: 'Impersonated requests cannot target another account',
          code: IMPERSONATION_INVALID_CODE,
        }),
        { status: 403, headers: { 'content-type': 'application/json' } },
      ),
    });
  }
  const accountId = impersonated ?? requested ?? await resolveAccountId(userId);

  const membership = await getAccountMembership(userId, accountId);
  if (!membership) {
    throw new HTTPException(403, { message: 'You do not have access to this account' });
  }
  (c as any).set('accountId', membership.accountId);
  setContextField('accountId', membership.accountId);

  return {
    userId,
    accountId: membership.accountId,
    accountRole: membership.accountRole as AccountRole,
  };
}

/**
 * THE alias table: the coarse `loadProjectForUser` parameter mapped onto a real
 * permission from `kortix.permissions`. Nothing else in the system speaks the
 * coarse vocabulary — bespoke actions (project.trigger.fire, project.secret.write,
 * …) call `assertProjectCapability` with the exact leaf.
 *
 *   read        -> project.read
 *   session     -> project.session.start
 *   write       -> project.write
 *   manage      -> project.write            (legacy admin-tier write)
 *   members     -> project.members.manage   (member administration)
 *   credentials -> project.credentials.issue (mint/revoke a project credential)
 *
 * `manage` KEEPS mapping to project.write on purpose: all 31 remaining `manage`
 * call sites stack their own explicit leaf assert immediately after
 * (project.customize.write, project.connector.write, project.secret.write, …),
 * so the coarse gate is the membership-tier question and the leaf gate is the
 * capability question. The two sites where that stack was MISSING are the ones
 * routes.md §5.2 named — `POST|DELETE /projects/:id/cli-token` — and they now
 * pass `credentials`.
 */
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
      return 'project.write';
    case 'members':
      return 'project.members.manage';
    case 'credentials':
      // Minting or revoking a credential that outlives the request is its own
      // capability, not "an admin-tier write". Before this leaf existed, a
      // project CLI token could be minted by anyone holding project.write.
      return 'project.credentials.issue';
  }
}


/**
 * Assert a SPECIFIC project capability (a leaf action like project.gitops.push)
 * for the current request. 403s on denial.
 *
 * The acting credential no longer has to be threaded by hand: it is part of the
 * `Actor` that `middleware/auth.ts` built, so the agent-grant fold and the token
 * project-scope check cannot be skipped by forgetting an argument. `userId` is
 * kept in the signature (194 call sites pass it) but is only used to assert that
 * the caller and the request agree.
 */
export async function assertProjectCapability(
  c: Context,
  userId: string,
  accountId: string,
  projectId: string,
  action: string,
  // Optional per-OBJECT narrowing: when supplied, the verdict is additionally
  // intersected with the object grants for this specific agent/skill.
  resource?: { type: 'agent' | 'skill'; id: string },
): Promise<void> {
  if (isRepositoryProjectAction(action)) {
    await assertAgentSessionWorkspaceAllowsRepository(c, accountId, projectId);
  }
  const actor = await actorOf(c, accountId);
  await assertAuthorized(actor, action, {
    type: 'project',
    id: projectId,
    ...(resource ? { resource } : {}),
  });
}

/**
 * Non-throwing sibling of assertProjectCapability: returns WHETHER the leaf is
 * allowed for the current request (threading the acting token so the agent-grant
 * fold fires), instead of 403-ing. For response-level filtering where a coarse
 * gate already passed but individual sections must be hidden per-capability —
 * e.g. GET /detail returns the project shell to any member but omits the file
 * list / a config sub-section the caller can't read, rather than denying the
 * whole bundle (which would lock a plain `member`, who lacks file.read, out of
 * the workspace entirely).
 */
export async function projectCapabilityAllowed(
  c: Context,
  userId: string,
  accountId: string,
  projectId: string,
  action: string,
): Promise<boolean> {
  if (
    isRepositoryProjectAction(action) &&
    !(await agentSessionWorkspaceAllowsRepository(c, accountId, projectId))
  ) {
    return false;
  }
  const verdict = await authorize(await actorOf(c, accountId), action, { type: 'project', id: projectId });
  return verdict.allowed;
}

function agentSessionIdFromRequest(c: Context): string | null {
  if (c.get('authType') !== 'pat') return null;
  const sessionId = c.get('sessionId');
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null;
}

export async function agentSessionWorkspaceAllowsRepository(
  c: Context,
  accountId: string,
  projectId: string,
): Promise<boolean> {
  const sessionId = agentSessionIdFromRequest(c);
  if (!sessionId) return true;
  return sessionWorkspaceAllowsRepositoryAccess({ sessionId, accountId, projectId });
}

export async function assertAgentSessionWorkspaceAllowsRepository(
  c: Context,
  accountId: string,
  projectId: string,
): Promise<void> {
  if (await agentSessionWorkspaceAllowsRepository(c, accountId, projectId)) return;
  throw new HTTPException(403, {
    message: 'session workspace does not allow repository access',
  });
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
  setContextField('accountId', row.accountId);
  setContextField('projectId', row.projectId);

  // ONE structured principal for the whole request, built from the credential
  // that authenticated it. Rebuilt here only when the project's account differs
  // from the one auth resolved (the dashboard case).
  const actor = await actorOf(c, row.accountId);
  const iamAction = iamActionForProjectAccess(action);

  // Membership, project role and the IAM verdict are independent lookups —
  // overlap them. Every project-scoped request runs this path; each DB
  // statement is a fast same-region roundtrip (~3ms measured, DB and API
  // both in eu-west-2), but they're serial by default, so running them in
  // parallel instead of stacked still matters at this call frequency.
  // The verdict comes from `kortix.role_assignments` only. `membership` and
  // `projectRole` are read here for the `accountRole` / `projectRole` /
  // `effectiveRole` LABELS the four read models render — they are not part of
  // the decision.
  const [membership, projectRole, verdict] = await Promise.all([
    getAccountMembership(userId, row.accountId),
    getProjectMemberRole(projectId, userId),
    authorize(actor, iamAction, { type: 'project', id: projectId }),
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
    // The engine already computed WHY. When the reason names a constraint other
    // than the caller's project role — an agent-session grant, a service
    // account's assigned role, MFA, token scope — report THAT.
    //
    // The role-probe below cannot: `project.read` is one of the two actions the
    // agent-grant fold never gates (AGENT_GRANT_EXEMPT_ACTIONS in iam/authorize),
    // so for an agent-session token the probe passes no matter what actually
    // denied the request. Every agent-scope and service-account-scope denial
    // therefore rendered as "your role is too low" — advice that told an
    // account owner running the meta coordinator to ask an account owner for a
    // higher role.
    if (denialReasonMessage(iamAction, verdict.reason) !== null) {
      throw buildDenialError(iamAction, verdict.reason);
    }
    // Genuine role denial. Distinguish "no access at all" from "has access but
    // not for this action" so the UI can show a meaningful message. A Viewer can
    // see the project but can't create a session — telling them "no access" is
    // misleading and they spend time wondering why they can see the page at
    // all. Only do the second probe when the failed action was NOT already
    // 'read' — otherwise it's the same answer.
    if (action !== 'read') {
      const readVerdict = await authorize(actor, 'project.read', { type: 'project', id: projectId });
      if (readVerdict.allowed) {
        // The two precise aliases name a real leaf, so they get the leaf's own
        // wording ("manage project members" / "issue project credentials")
        // rather than the coarse "change this project" — the coarse phrasing is
        // what made a members-only denial read as a project-wide one.
        if (action === 'members' || action === 'credentials') {
          throw buildDenialError(iamAction, verdict.reason);
        }
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

  return {
    row,
    userId,
    accountRole: accountRole ?? null,
    projectRole,
    effectiveRole: effectiveRole as ProjectRole,
    adminBypass,
    /** The request's canonical principal, so a handler that needs a second
     *  verdict or an assignment write does not rebuild it. */
    actor,
  };
}

// Env names a project secret must NEVER inject into a sandbox — they belong to
// the sandbox's own runtime (the OS, the daemon, opencode). A secret named e.g.
// `PORT` (trivially pushed via `kortix env push --from a-server.env`) would
// override the runtime and break every session. Anything `KORTIX_*`/`OPENCODE_*`
// is platform-owned and set explicitly below.
