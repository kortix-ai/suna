import {
  isSessionTargetVisibleToCaller,
  isProjectSessionVisibleTo,
  isTriggerRunSession,
  loadSessionGrants,
  mayManageSessionSharing,
  resolveShareSubject,
  type SecretGrant,
  type SessionNarrowingContext,
  type ShareSubject,
} from '../../connectors/share';
// Straight from the engine, not the barrel (see project-access.ts): the barrel
// is replaced wholesale by `mock.module` in several route tests.
import { authorize } from '../../iam/authorize';
import { isAgentPrincipalActor, type Actor } from '../../iam/actor';
import { agentSessionStanding } from './agent-session-standing';
import { hasAccountSessionOversight } from '../../iam/session-oversight';
import { recordAuditEvent } from '../../shared/audit';
import { db } from '../../shared/db';
import { projectSessions, serviceAccounts } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { ttlMemo } from '../../shared/ttl-memo';
import { roleAllows, type ProjectRole } from '../access';
import type { ProjectRow, ProjectSessionRow } from './serializers';

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

/**
 * Manager standing for the session LIST/serialization path: role standing, or a
 * `project.members.manage` capability probe — both behind the same binding gate
 * as `callerHasManagerStanding`.
 *
 * The list route used to compute this from the role alone, so a session-bound
 * agent credential launched by a manager saw `can_manage_lifecycle: true` on
 * every row while DELETE — which derives standing through `loadVisibleSession`
 * and strips bound credentials — refused it with the owner-or-manager 403. One
 * caller, two answers. Deriving both from this predicate ends the disagreement,
 * and it also closes the `scope=project` inventory to bound credentials, which
 * were never meant to wield the launching user's manage role.
 *
 * The probe is injected, not imported: it needs the request context, and taking
 * it as a thunk keeps this decidable in a unit test without one. It is never
 * invoked for a bound credential — standing there is false before any I/O.
 */
export async function viewerManagerStanding(
  effectiveRole: ProjectRole,
  boundCredentialSessionId: string | null,
  probeManageCapability: () => Promise<boolean>,
): Promise<boolean> {
  if (boundCredentialSessionId !== null) return false;
  if (roleAllows(effectiveRole, 'manage')) return true;
  return probeManageCapability();
}

/**
 * A soft-deleted session is gone for every runtime verb, exactly as it is for
 * the read-by-id and the default list. `deleteSession` only stamps
 * `metadata.deletedAt` (the row itself survives for `scope=project` tombstone
 * inventory), so any route that loads a session by id and then acts on it must
 * ask this first — `/start` and `/restart` used to skip it, answer
 * `stage: "stopped"` / 202 on a deleted session, and leave the UI looping on a
 * Restart button that could never work (sampleco session b04a9911, 2026-08-24).
 */
export function sessionIsTombstoned(row: { metadata: unknown }): boolean {
  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  return typeof metadata.deletedAt === 'string';
}

/**
 * Audit a session read that only account session oversight allowed. Deduped to
 * one event per (admin, session) per hour: `loadVisibleSession` runs on every
 * poll of an open session, and one row per poll would bury the log. The first
 * open is always recorded on each replica.
 */
const OVERSIGHT_AUDIT_WINDOW_MS = 60 * 60 * 1000;
const OVERSIGHT_AUDIT_MAX_ENTRIES = 5_000;
const oversightAuditedAt = new Map<string, number>();

async function recordOversightSessionRead(input: {
  accountId: string;
  userId: string;
  sessionId: string;
  ownerId: string | null;
  visibility: string;
}): Promise<void> {
  const key = `${input.userId}|${input.sessionId}`;
  const now = Date.now();
  const last = oversightAuditedAt.get(key);
  if (last !== undefined && now - last < OVERSIGHT_AUDIT_WINDOW_MS) return;
  if (oversightAuditedAt.size >= OVERSIGHT_AUDIT_MAX_ENTRIES) oversightAuditedAt.clear();
  oversightAuditedAt.set(key, now);
  await recordAuditEvent({
    accountId: input.accountId,
    actorUserId: input.userId,
    action: 'project.admin_oversight_session_read',
    resourceType: 'project_session',
    resourceId: input.sessionId,
    metadata: {
      via: 'account_session_oversight',
      sessionOwnerId: input.ownerId,
      sessionVisibility: input.visibility,
    },
  });
}

/** The `loaded` shape `loadVisibleSession` and its helpers receive. */
type VisibleSessionRequest = {
  row: ProjectRow;
  userId: string;
  effectiveRole: ProjectRole;
  adminBypass?: boolean;
  actor?: Actor | null;
};

async function sessionReadPrefetch(
  loaded: VisibleSessionRequest,
  sessionId: string,
): Promise<{ row: ProjectSessionRow; subject: ShareSubject; grants: SecretGrant[] } | null> {
  // The caller's share subject (their groups) and the session's grants are
  // keyed on the user and the session id, not on anything the row returns, so
  // all three reads go out together. Every session-scoped route pays this
  // path, and one behind the other is three round trips.
  const subjectRead = resolveShareSubject(loaded.userId);
  const grantsRead = loadSessionGrants([sessionId]);
  subjectRead.catch(() => undefined);
  grantsRead.catch(() => undefined);
  const row = await loadProjectSessionRow(loaded, sessionId);
  if (!row) return null;
  const subject = await subjectRead;
  const grants = (await grantsRead).get(sessionId) ?? [];
  return { row, subject, grants };
}

async function sessionManagerStanding(
  loaded: VisibleSessionRequest,
  ownership: SessionNarrowingContext,
  row: ProjectSessionRow,
  boundCredentialSessionId: string | null,
): Promise<boolean> {
  let canManageProject = callerHasManagerStanding(loaded.effectiveRole, boundCredentialSessionId);
  if (
    !canManageProject &&
    boundCredentialSessionId === null &&
    isSessionTargetVisibleToCaller(ownership) &&
    isTriggerRunSession(row)
  ) {
    canManageProject = loaded.actor
      ? (
          // `project.trigger.update`, not `project.members.manage` (Marko,
          // 2026-09-03: "wtf, based on members.manage you get access to the
          // triggered sessions"). Whoever may change what a trigger does may
          // read what it produced; administering people is a different power
          // and must not unlock session content.
          await authorize(loaded.actor, 'project.trigger.update', {
            type: 'project',
            id: loaded.row.projectId,
          })
        ).allowed
      : false;
  }
  return canManageProject;
}

async function sessionReadAccess(
  loaded: VisibleSessionRequest,
  row: ProjectSessionRow,
  sessionId: string,
  subject: ShareSubject,
  grants: SecretGrant[],
  callerSessionId: string | null,
  boundCredentialSessionId: string | null,
): Promise<{ canManageProject: boolean; isOwner: boolean } | null> {
  const ownership = {
    origin: row.origin ?? null,
    sessionId,
    callerSessionId,
    boundCredentialSessionId,
  };
  const canManageProject = await sessionManagerStanding(loaded, ownership, row, boundCredentialSessionId);
  const visibility = row.visibility as 'private' | 'project' | 'restricted';
  let visible = isProjectSessionVisibleTo(
    visibility,
    row.createdBy,
    grants,
    subject,
    ownership,
    { metadata: row.metadata, initiatorType: row.initiatorType, canManageProject },
  );
  // Account session oversight: asked only when ordinary visibility refused, so
  // the common path never pays for it, and only for a human credential.
  if (
    !visible &&
    boundCredentialSessionId === null &&
    (await hasAccountSessionOversight(loaded.userId, loaded.row.accountId))
  ) {
    visible = isProjectSessionVisibleTo(visibility, row.createdBy, grants, subject, ownership, {
      metadata: row.metadata,
      initiatorType: row.initiatorType,
      canManageProject,
      accountSessionOversight: true,
    });
    if (visible) {
      await recordOversightSessionRead({
        accountId: loaded.row.accountId,
        userId: loaded.userId,
        sessionId,
        ownerId: row.createdBy ?? null,
        visibility: row.visibility,
      });
    }
  }
  // An agent session always opens itself and the sessions it spawned. A trigger
  // run's `created_by` is the agent's service account, never the token's user, so
  // the ownership rule above refuses it its own row (404 on `kortix reminders`).
  if (
    !visible &&
    loaded.actor &&
    isAgentPrincipalActor(loaded.actor) &&
    agentSessionStanding(boundCredentialSessionId, row, false).isOwner
  ) {
    visible = true;
  }
  if (!visible) {
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
  let isOwner = row.createdBy === loaded.userId;
  if (loaded.actor && isAgentPrincipalActor(loaded.actor)) {
    // Spec §2: never the launcher's standing. Checked after the ordinary
    // rules so it can only narrow them.
    const standing = agentSessionStanding(boundCredentialSessionId, row, visible);
    if (!standing.visible) return null;
    isOwner = standing.isOwner;
  }
  return { canManageProject, isOwner };
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
  const prefetch = await sessionReadPrefetch(loaded, sessionId);
  if (!prefetch) return null;
  const { row, subject, grants } = prefetch;
  const access = await sessionReadAccess(
    loaded, row, sessionId, subject, grants, callerSessionId, boundCredentialSessionId,
  );
  if (!access) return null;
  const { canManageProject, isOwner } = access;
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
  loaded: { row: ProjectRow; userId: string; effectiveRole: ProjectRole; actor?: Actor | null },
  sessionId: string,
  /**
   * The caller's AGENT/SANDBOX token binding — always `callerKortixSessionId(c)`,
   * never the raw `c.get('sessionId')` (that is the Supabase LOGIN session id
   * for a signed-in human, which would narrow every human away from a
   * backend-origin session). Sharing is the worst surface to leave unnarrowed:
   * a public share is UNAUTHENTICATED and its router is mounted before auth,
   * so minting one against another end-user's session exposes their live app
   * port and workspace files to anyone holding the URL.
   */
  boundCredentialSessionId: string | null,
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
    callerSessionId: boundCredentialSessionId,
    boundCredentialSessionId,
  })) {
    return null;
  }
  let isOwner = row.createdBy === loaded.userId;
  if (loaded.actor && isAgentPrincipalActor(loaded.actor)) {
    // Spec §2: an agent session manages share links only for sessions it
    // owns (its own and its children), never the launcher's others.
    const standing = agentSessionStanding(boundCredentialSessionId, row, true);
    if (!standing.visible) return null;
    isOwner = standing.isOwner;
  }
  // Same standing rule as loadVisibleSession: a session-bound credential acts
  // for one session and does not carry the launching user's manage role.
  const canManageProject = callerHasManagerStanding(loaded.effectiveRole, boundCredentialSessionId);
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
