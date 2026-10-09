// Who follows a session (KRTX-1742). The creator follows implicitly; a person
// who prompts the session starts following it; anyone may mute or unmute. A
// muted row silences that user for this session, the creator included.
import { and, eq, sql } from 'drizzle-orm';
import { notificationWatchers } from '@kortix/db';
import { db } from '../shared/db';

export interface SessionWatchers {
  /** Creator (unless muted) plus every unmuted row. */
  watching: string[];
  muted: Set<string>;
}

export async function sessionWatchersOf(sessionId: string, createdBy: string | null): Promise<SessionWatchers> {
  const rows = await db
    .select({ userId: notificationWatchers.userId, muted: notificationWatchers.muted })
    .from(notificationWatchers)
    .where(eq(notificationWatchers.sessionId, sessionId));
  const muted = new Set(rows.filter((row) => row.muted).map((row) => row.userId));
  const watching = new Set(rows.filter((row) => !row.muted).map((row) => row.userId));
  if (createdBy && !muted.has(createdBy)) watching.add(createdBy);
  return { watching: [...watching], muted };
}

/** A prompter starts following the session. Never un-mutes. */
export async function autoWatchSession(projectId: string, sessionId: string, userId: string): Promise<void> {
  await db
    .insert(notificationWatchers)
    .values({ projectId, sessionId, userId, muted: false })
    .onConflictDoNothing({ target: [notificationWatchers.sessionId, notificationWatchers.userId] });
}

/** Follow (`watching: true`) or mute (`false`) a session for one user. */
export async function setSessionWatch(projectId: string, sessionId: string, userId: string, watching: boolean): Promise<void> {
  await db
    .insert(notificationWatchers)
    .values({ projectId, sessionId, userId, muted: !watching })
    .onConflictDoUpdate({
      target: [notificationWatchers.sessionId, notificationWatchers.userId],
      set: { muted: !watching, updatedAt: sql`now()` },
    });
}

/** Does `userId` get this session's notifications? */
export async function isWatchingSession(sessionId: string, userId: string, createdBy: string | null): Promise<boolean> {
  const [row] = await db
    .select({ muted: notificationWatchers.muted })
    .from(notificationWatchers)
    .where(and(eq(notificationWatchers.sessionId, sessionId), eq(notificationWatchers.userId, userId)))
    .limit(1);
  if (row) return !row.muted;
  return createdBy === userId;
}
