// May this person still see what a notification names (KRTX-1742)? Checked
// when a notification is written AND when it is read, listed or emailed, so a
// revoked share, a lost project or a session made private stops showing its
// title and question text.
//
// Background-safe: no Hono context, no audit write, never throws (a failure
// means "no"). The rules are the request path's:
//   - project: `listAccessible` — account membership, the project grant,
//     owners/admins on every project, SSO-only enforcement. It skips the MFA
//     step-up on purpose; the inbox READ applies that gate itself.
//   - session: `isProjectSessionVisibleTo` — owner, project-visible, named or
//     group grants, the trigger-run manager override, account oversight.
//   - a soft-deleted session (`metadata.deletedAt`) is never visible.
// A recipient is also always a person: a member of the account
// (`personsAmong`). A service account or any other non-person id that the IAM
// lets in is never told.
import { projectSessions } from '@kortix/db';
import { inArray } from 'drizzle-orm';
import { PROJECT_ACTIONS } from '../iam/actions';
import { listAccessible, type Accessible } from '../iam/authorize';
import { groupIdsOfUser } from '../iam/group-read';
import { accountMembersAmong } from '../iam/membership-read';
import { hasAccountSessionOversight } from '../iam/session-oversight';
import { isProjectSessionVisibleTo, loadSessionGrants, type SecretGrant, type SessionVisibility } from '../connectors/share';
import { logger } from '../lib/logger';
import { db } from '../shared/db';
import { mapWithConcurrency } from '../shared/map-with-concurrency';
import { isUuid } from '../shared/validate';

/** Recipient checks in flight at once: one check is up to ~7 queries on a 5-connection pool. */
const RECIPIENT_CHECK_CONCURRENCY = 4;

export interface SessionAccessRow {
  sessionId: string;
  accountId: string;
  projectId: string;
  createdBy: string | null;
  visibility: string;
  metadata: unknown;
  origin: string | null;
  initiatorType: string | null;
}

function allows(accessible: Accessible, projectId: string): boolean {
  return accessible.mode === 'all' || (accessible.mode === 'allow_only' && accessible.allowed.has(projectId));
}

function isTombstoned(metadata: unknown): boolean {
  return !!metadata && typeof metadata === 'object' && typeof (metadata as Record<string, unknown>).deletedAt === 'string';
}

async function projectAccess(userId: string, accountId: string, action: string): Promise<Accessible> {
  try {
    return await listAccessible({ userId, accountId, credential: { kind: 'jwt' }, ctx: {} }, action, 'project');
  } catch {
    return { mode: 'none' };
  }
}

/** The session rows the access checks need, keyed by session id. */
export async function loadSessionAccessRows(sessionIds: readonly string[]): Promise<Map<string, SessionAccessRow>> {
  const out = new Map<string, SessionAccessRow>();
  const ids = [...new Set(sessionIds)].filter(Boolean);
  if (ids.length === 0) return out;
  const rows = await db
    .select({
      sessionId: projectSessions.sessionId,
      accountId: projectSessions.accountId,
      projectId: projectSessions.projectId,
      createdBy: projectSessions.createdBy,
      visibility: projectSessions.visibility,
      metadata: projectSessions.metadata,
      origin: projectSessions.origin,
      initiatorType: projectSessions.initiatorType,
    })
    .from(projectSessions)
    .where(inArray(projectSessions.sessionId, ids));
  for (const row of rows) out.set(row.sessionId, row as SessionAccessRow);
  return out;
}

/**
 * The ids of the sessions in `rows` that `userId` may open now. One project
 * listing per account, one group read, one grants read for the batch.
 */
export async function maySeeSessions(userId: string, rows: readonly SessionAccessRow[]): Promise<Set<string>> {
  const visible = new Set<string>();
  if (!userId || rows.length === 0) return visible;
  try {
    const live = rows.filter((row) => !isTombstoned(row.metadata));
    if (live.length === 0) return visible;
    const accounts = [...new Set(live.map((row) => row.accountId))];
    const read = new Map<string, Accessible>();
    const manage = new Map<string, Accessible>();
    const oversight = new Map<string, boolean>();
    await Promise.all(accounts.map(async (accountId) => {
      const [r, m, o] = await Promise.all([
        projectAccess(userId, accountId, PROJECT_ACTIONS.PROJECT_SESSION_READ),
        projectAccess(userId, accountId, PROJECT_ACTIONS.PROJECT_TRIGGER_UPDATE),
        hasAccountSessionOversight(userId, accountId).catch(() => false),
      ]);
      read.set(accountId, r);
      manage.set(accountId, m);
      oversight.set(accountId, o);
    }));
    const inProject = live.filter((row) => allows(read.get(row.accountId)!, row.projectId));
    if (inProject.length === 0) return visible;
    const [groupRows, grants] = await Promise.all([
      groupIdsOfUser(userId),
      loadSessionGrants(inProject.map((row) => row.sessionId)),
    ]);
    const subject = { userId, groupIds: groupRows.map((g) => g.groupId) };
    for (const row of inProject) {
      const ok = isProjectSessionVisibleTo(
        row.visibility as SessionVisibility,
        row.createdBy,
        grants.get(row.sessionId) ?? ([] as SecretGrant[]),
        subject,
        { origin: row.origin, sessionId: row.sessionId, callerSessionId: null, boundCredentialSessionId: null },
        {
          metadata: row.metadata,
          initiatorType: row.initiatorType,
          canManageProject: allows(manage.get(row.accountId)!, row.projectId),
          accountSessionOversight: oversight.get(row.accountId) === true,
        },
      );
      if (ok) visible.add(row.sessionId);
    }
  } catch (err) {
    logger.warn('[notify] session access check failed', { error: err instanceof Error ? err.message : String(err) });
  }
  return visible;
}

/**
 * The people among `ids`, in order, once each: the members of the account.
 * One query. Never throws: a failed read means nobody.
 */
export async function personsAmong(accountId: string, ids: readonly string[]): Promise<string[]> {
  const unique = [...new Set(ids.filter(isUuid))];
  if (unique.length === 0) return [];
  try {
    const members = new Set((await accountMembersAmong(accountId, unique)).map((row) => row.userId));
    return unique.filter((id) => members.has(id));
  } catch (err) {
    logger.warn('[notify] member check failed', { error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

/** The people among `userIds` who may open `session` now. */
export async function filterSessionRecipients(session: SessionAccessRow, userIds: readonly string[]): Promise<string[]> {
  const people = await personsAmong(session.accountId, userIds);
  const results = await mapWithConcurrency(people, RECIPIENT_CHECK_CONCURRENCY, async (userId) =>
    (await maySeeSessions(userId, [session])).has(session.sessionId));
  return people.filter((_, i) => results[i]);
}

/** The projects among `projectIds` in `accountId` whose triggers `userId` may read now. */
export async function mayReadProjectTriggers(
  userId: string,
  accountId: string,
  projectIds: readonly string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  if (!userId || projectIds.length === 0) return out;
  const accessible = await projectAccess(userId, accountId, PROJECT_ACTIONS.PROJECT_TRIGGER_READ);
  for (const projectId of projectIds) if (allows(accessible, projectId)) out.add(projectId);
  return out;
}

/** The people among `userIds` who may read the triggers of one project now. */
export async function filterTriggerRecipients(
  accountId: string,
  projectId: string,
  userIds: readonly string[],
): Promise<string[]> {
  const people = await personsAmong(accountId, userIds);
  const results = await mapWithConcurrency(people, RECIPIENT_CHECK_CONCURRENCY, async (userId) =>
    (await mayReadProjectTriggers(userId, accountId, [projectId])).has(projectId));
  return people.filter((_, i) => results[i]);
}
