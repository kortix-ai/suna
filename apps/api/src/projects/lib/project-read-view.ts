/**
 * Which rows of a project's work this caller reads: the full project, or
 * only their own work and the sessions they may open.
 *
 * A caller who holds `project.members.manage` on a human credential (a manager,
 * an owner, an account admin) reads every row. Everyone else — a plain
 * `member`, or any session-bound agent credential — reads a row only when they
 * created it or when its session is one they may open ("Who can open a
 * session": `loadVisibleSession`). Change requests, the review inbox, gateway
 * logs, gateway spend and git refs of sessions all ask this one question.
 *
 * Neither view reads a session of a private channel the caller is not in
 * (`hiddenSpaceIds`): a manager outside the channel does not read its threads'
 * work. Spend totals that name no session keep every row.
 */
import type { Context } from 'hono';
import { projectSessions } from '@kortix/db';
import { type AnyColumn, type SQL, and, eq, exists, inArray, notExists, or, sql } from 'drizzle-orm';
import { PROJECT_ACTIONS } from '../../iam/actions';
import { isAgentPrincipalActor } from '../../iam/actor';
import { callerKortixSessionId } from '../../middleware/caller-session';
import { db } from '../../shared/db';
import { uuidsIn } from '../../shared/validate';
import { loadProjectForUser, projectCapabilityAllowed } from './http-project-access';
import { sessionListViewerSql } from './session-list';
import { loadVisibleSession, viewerManagerStanding } from './session-visibility';
import { hiddenSpaceIds } from '../../shared/space-access';

type LoadedProject = NonNullable<Awaited<ReturnType<typeof loadProjectForUser>>>;

export interface ProjectReadView {
  /** True: the caller reads every row of the project. */
  full: boolean;
  /**
   * SQL twin of `allows`: rows whose session the caller may open, or that the
   * caller created. Undefined in the full view (no filter).
   */
  where(sessionColumn: AnyColumn | SQL, createdByColumn?: AnyColumn): SQL | undefined;
  /** May the caller read a row with this session and creator? */
  allows(row: { sessionId?: string | null; createdBy?: string | null }): Promise<boolean>;
  /**
   * May the caller read these git refs? A session branch is named by its
   * session id, so a ref that contains a UUID the caller may not open as a
   * session (`<id>`, `origin/<id>`, `<id>~2`) is refused.
   */
  refsVisible(...refs: Array<string | null | undefined>): Promise<boolean>;
  /** Of these session ids, the ones the caller may read the work of. */
  visibleSessionIds(ids: readonly string[]): Promise<Set<string>>;
  /**
   * Of these session ids, the ones the caller may open as a session. The full
   * view reads every session's work, but a manager may still not open another
   * person's private session, and the session list hides its title.
   */
  openableSessionIds(ids: readonly string[]): Promise<Set<string>>;
}

/**
 * Manager standing for project-wide reads. A session-bound credential never
 * carries it (`viewerManagerStanding`).
 */
export async function callerManagesProject(c: Context, loaded: LoadedProject): Promise<boolean> {
  return viewerManagerStanding(callerKortixSessionId(c), () =>
    projectCapabilityAllowed(
      c,
      loaded.userId,
      loaded.row.accountId,
      loaded.row.projectId,
      PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE,
    ),
  );
}

export async function projectReadView(c: Context, loaded: LoadedProject): Promise<ProjectReadView> {
  const bound = callerKortixSessionId(c);
  const hidden = [...(await hiddenSpaceIds(loaded.row.projectId, loaded.userId, bound))];
  // The sessions this caller may open, by the session list's SQL rules
  // (`sessionListViewerSql`, the twin of `isProjectSessionVisibleTo`).
  // Deleted sessions stay in: their work is still the caller's.
  const visibleSql = and(
    eq(projectSessions.projectId, loaded.row.projectId),
    eq(projectSessions.accountId, loaded.row.accountId),
    sessionListViewerSql({
      scope: 'project',
      viewerId: loaded.userId,
      boundCredentialSessionId: bound,
      agentPrincipal: loaded.actor ? isAgentPrincipalActor(loaded.actor) : false,
      canManageProject: false,
      accountSessionOversight: false,
      hiddenSpaceIds: new Set(hidden),
    }),
  );
  const visibleSessionIdsSql = db
    .select({ sessionId: projectSessions.sessionId })
    .from(projectSessions)
    .where(visibleSql);
  const visibleSessionIds = async (ids: readonly string[]): Promise<Set<string>> => {
    const out = new Set<string>();
    // A busy repository carries thousands of session branches: stay far below
    // the 65,535 bind-parameter limit per statement.
    for (let i = 0; i < ids.length; i += 5_000) {
      const rows = await db
        .select({ sessionId: projectSessions.sessionId })
        .from(projectSessions)
        .where(
          and(
            inArray(projectSessions.sessionId, ids.slice(i, i + 5_000)),
            inArray(projectSessions.sessionId, visibleSessionIdsSql),
          ),
        );
      for (const row of rows) out.add(row.sessionId);
    }
    return out;
  };
  if (await callerManagesProject(c, loaded)) {
    if (hidden.length === 0) {
      return {
        full: true,
        where: () => undefined,
        allows: async () => true,
        refsVisible: async () => true,
        visibleSessionIds: async (ids) => new Set(ids),
        openableSessionIds: visibleSessionIds,
      };
    }
    // Every row but those of a hidden private channel's sessions.
    const inHiddenSpace = and(eq(projectSessions.projectId, loaded.row.projectId), inArray(projectSessions.spaceId, hidden));
    const hiddenAmong = async (ids: readonly string[]): Promise<Set<string>> => {
      const out = new Set<string>();
      for (let i = 0; i < ids.length; i += 5_000) {
        const rows = await db
          .select({ sessionId: projectSessions.sessionId })
          .from(projectSessions)
          .where(and(inArray(projectSessions.sessionId, ids.slice(i, i + 5_000)), inHiddenSpace));
        for (const row of rows) out.add(row.sessionId);
      }
      return out;
    };
    const fullVisible = async (ids: readonly string[]): Promise<Set<string>> => {
      const out = await hiddenAmong(ids);
      return new Set(ids.filter((id) => !out.has(id)));
    };
    return {
      full: true,
      where: (sessionColumn) => {
        if (sessionColumn === projectSessions.sessionId) {
          throw new Error('projectReadView.where needs the outer table\'s session column, not project_sessions.session_id');
        }
        return notExists(
          db
            .select({ one: sql`1` })
            .from(projectSessions)
            .where(and(eq(projectSessions.sessionId, sessionColumn), inHiddenSpace)),
        );
      },
      allows: async (row) => !row.sessionId || (await fullVisible([row.sessionId])).has(row.sessionId),
      refsVisible: async (...refs) => {
        const ids = refs.flatMap((ref) => (ref ? uuidsIn(ref) : []));
        return ids.length === 0 || (await hiddenAmong(ids)).size === 0;
      },
      visibleSessionIds: fullVisible,
      openableSessionIds: visibleSessionIds,
    };
  }
  return {
    full: false,
    visibleSessionIds,
    openableSessionIds: visibleSessionIds,
    refsVisible: async (...refs) => {
      const ids = refs.flatMap((ref) => (ref ? uuidsIn(ref) : []));
      if (ids.length === 0) return true;
      const visible = await visibleSessionIds(ids);
      return ids.every((id) => visible.has(id));
    },
    // A correlated EXISTS, not `IN (visible ids)`: under the OR the IN form is
    // always a hashed subplan that reads (and detoasts the metadata of) every
    // session of the project, ~600 ms on a 15k-session project for 4 pending
    // calls. EXISTS lets the planner probe the session by primary key per row,
    // and it still picks the hashed form when the outer side is large.
    // The inner query reads `project_sessions` unaliased: passed its own
    // `session_id`, the EXISTS would compare the column to itself and admit
    // every row. Refuse that instead of leaking.
    where: (sessionColumn, createdByColumn) => {
      if (sessionColumn === projectSessions.sessionId) {
        throw new Error('projectReadView.where needs the outer table\'s session column, not project_sessions.session_id');
      }
      return or(
        exists(
          db
            .select({ one: sql`1` })
            .from(projectSessions)
            .where(and(eq(projectSessions.sessionId, sessionColumn), visibleSql)),
        ),
        createdByColumn ? eq(createdByColumn, loaded.userId) : undefined,
      );
    },
    allows: async (row) => {
      if (row.createdBy && row.createdBy === loaded.userId) return true;
      if (!row.sessionId) return false;
      return (await loadVisibleSession(loaded, row.sessionId, c.get('sessionId') ?? null, bound)) !== null;
    },
  };
}
