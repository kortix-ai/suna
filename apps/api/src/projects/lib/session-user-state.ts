// One person's pins and archive in a project's session list. Per person, so a
// shared session can be pinned by one member and archived by another; neither
// write touches the session row, so `updated_at` and the list order stay.
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { projectSessionUserStates, projectSessions } from '@kortix/db';
import { db } from '../../shared/db';
import { qualifiedColumn } from '../../shared/sql-qualified-column';

/** `pinned`: only the person's pinned sessions. `archived`: only the archived ones. */
export type SessionListView = 'pinned' | 'archived';

export interface SessionUserState {
  pinnedAt: Date | null;
  archivedAt: Date | null;
}

const returned = { pinnedAt: projectSessionUserStates.pinnedAt, archivedAt: projectSessionUserStates.archivedAt };
const conflictTarget = [projectSessionUserStates.sessionId, projectSessionUserStates.userId];

/** Pinning a session takes it out of the archive. A repeated pin keeps its first time. */
export async function setSessionPinned(sessionId: string, userId: string, pinned: boolean): Promise<SessionUserState> {
  const [row] = await db
    .insert(projectSessionUserStates)
    .values({ sessionId, userId, pinnedAt: pinned ? sql`now()` : null })
    .onConflictDoUpdate({
      target: conflictTarget,
      set: pinned
        ? { pinnedAt: sql`coalesce(${projectSessionUserStates.pinnedAt}, now())`, archivedAt: null, updatedAt: sql`now()` }
        : { pinnedAt: null, updatedAt: sql`now()` },
    })
    .returning(returned);
  return row!;
}

/** Archiving a session unpins it. A repeated archive keeps its first time. */
export async function setSessionArchived(sessionId: string, userId: string, archived: boolean): Promise<SessionUserState> {
  const [row] = await db
    .insert(projectSessionUserStates)
    .values({ sessionId, userId, archivedAt: archived ? sql`now()` : null })
    .onConflictDoUpdate({
      target: conflictTarget,
      set: archived
        ? { archivedAt: sql`coalesce(${projectSessionUserStates.archivedAt}, now())`, pinnedAt: null, updatedAt: sql`now()` }
        : { archivedAt: null, updatedAt: sql`now()` },
    })
    .returning(returned);
  return row!;
}

/** The person's state for each of these sessions. A session absent from the map has neither. */
export async function loadSessionUserStates(sessionIds: string[], userId: string): Promise<Map<string, SessionUserState>> {
  if (sessionIds.length === 0) return new Map();
  const rows = await db
    .select({ sessionId: projectSessionUserStates.sessionId, ...returned })
    .from(projectSessionUserStates)
    .where(and(eq(projectSessionUserStates.userId, userId), inArray(projectSessionUserStates.sessionId, sessionIds)));
  return new Map(rows.map(({ sessionId, ...state }) => [sessionId, state]));
}

/**
 * The list WHERE for one person: their pinned or archived sessions, or, with
 * no view, every session they have not archived. Null `personId` (an agent,
 * an API key, a service account) has no pins or archive: the raw list, and no
 * rows for a view.
 */
export function sessionUserStateSql(view: SessionListView | null, personId: string | null): SQL | undefined {
  if (!personId) return view ? sql`false` : undefined;
  const stamp = view === 'pinned' ? sql`state.pinned_at` : sql`state.archived_at`;
  const exists = sql`exists (
    select 1 from ${projectSessionUserStates} as state
     where state.session_id = ${qualifiedColumn(projectSessions.sessionId)}
       and state.user_id = ${personId}::uuid
       and ${stamp} is not null)`;
  return view ? exists : sql`not ${exists}`;
}

/** Account erasure: the person's pins and archive, in every account. */
export async function deleteUserSessionStates(userId: string): Promise<void> {
  await db.delete(projectSessionUserStates).where(eq(projectSessionUserStates.userId, userId));
}

/** A member left or was removed: their pins and archive in the account's sessions go. */
export async function deleteMemberSessionStates(accountId: string, userId: string): Promise<void> {
  const accountSessions = db
    .select({ id: projectSessions.sessionId })
    .from(projectSessions)
    .where(eq(projectSessions.accountId, accountId));
  await db
    .delete(projectSessionUserStates)
    .where(and(eq(projectSessionUserStates.userId, userId), inArray(projectSessionUserStates.sessionId, accountSessions)));
}
