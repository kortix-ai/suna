/**
 * Conversations with people: `POST /sessions` `participants`, addressed by
 * email. A participant is an account member who may run sessions in the
 * project, because answering is sending a prompt (`POST .../prompts` asks
 * `project.session.start`). Anyone else is refused by name, so the sender
 * learns who could not be reached instead of opening a conversation nobody
 * can answer.
 */
import { projectSessions, sessionLifecycleCommands } from '@kortix/db';
import type { SessionMessageSender } from '@kortix/shared';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../shared/db';
import { resolveUserIdentities } from './user-identity';

export const MAX_SESSION_PARTICIPANTS = 20;

export interface SessionParticipant {
  userId: string;
  email: string;
  name: string;
}

type ResolveResult =
  | { people: SessionParticipant[] }
  | { status: 400 | 404; error: string; code: string };

export async function resolveSessionParticipants(
  accountId: string,
  projectId: string,
  raw: unknown,
): Promise<ResolveResult> {
  const list = typeof raw === 'string' ? [raw] : raw;
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_SESSION_PARTICIPANTS) {
    return { status: 400, code: 'INVALID_PARTICIPANTS', error: `participants must be 1-${MAX_SESSION_PARTICIPANTS} email addresses` };
  }
  const emails = [...new Set(list.map((e) => (typeof e === 'string' ? e.trim().toLowerCase() : '')))];
  const invalid = emails.filter((e) => !/^[^\s@,"{}\\]+@[^\s@,"{}\\]+$/.test(e));
  if (invalid.length > 0) {
    return { status: 400, code: 'INVALID_PARTICIPANTS', error: `Not an email address: ${invalid.join(', ') || '(empty)'}` };
  }
  const rows = (await db.execute(sql`
    SELECT u.id::text AS id, lower(u.email) AS email,
           coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name') AS name
    FROM auth.users u
    JOIN kortix.account_memberships m ON m.user_id = u.id AND m.account_id = ${accountId}::uuid
    WHERE lower(u.email) = ANY(${`{${emails.join(',')}}`}::text[])
  `)) as unknown as Array<{ id: string; email: string; name: string | null }>;
  const byEmail = new Map(rows.map((row) => [row.email, row]));
  const [{ actorForUser }, { authorize }, { PROJECT_ACTIONS }] = await Promise.all([
    import('../../iam/actor'), import('../../iam/authorize'), import('../../iam/actions'),
  ]);
  const people: SessionParticipant[] = [];
  const unreachable: string[] = [];
  for (const email of emails) {
    const row = byEmail.get(email);
    const allowed = row
      ? (await authorize(actorForUser(row.id, accountId), PROJECT_ACTIONS.PROJECT_SESSION_START, { type: 'project', id: projectId })).allowed
      : false;
    if (!row || !allowed) unreachable.push(email);
    else people.push({ userId: row.id, email, name: row.name?.trim() || email });
  }
  if (unreachable.length > 0) {
    return {
      status: 404,
      code: 'PARTICIPANT_NOT_FOUND',
      error: `No member of this project can be reached at ${unreachable.join(', ')}. Find members with \`kortix access ls\`.`,
    };
  }
  return { people };
}

/** Who a message says it is from: the calling session, else the person. */
export async function sessionMessageSender(
  userId: string,
  callerSessionId: string | null,
  projectId: string,
): Promise<SessionMessageSender> {
  if (callerSessionId) {
    const [row] = await db
      .select({ metadata: projectSessions.metadata })
      .from(projectSessions)
      .where(and(eq(projectSessions.sessionId, callerSessionId), eq(projectSessions.projectId, projectId)))
      .limit(1);
    const meta = (row?.metadata ?? {}) as Record<string, unknown>;
    const title = [meta.custom_name, meta.name].find((v): v is string => typeof v === 'string' && !!v.trim());
    return { kind: 'session', sessionId: callerSessionId, title: title ?? 'Untitled session' };
  }
  const identity = (await resolveUserIdentities([userId])).get(userId);
  const email = identity?.email ?? '';
  return { kind: 'person', name: identity?.displayName?.trim() || email || 'A member', email };
}

/**
 * A session's agent may message a session it cannot otherwise see in two
 * cases: its own parent (a worker reporting back, an ask answering its
 * asker), and a session that messaged it first (a reply). Only the prompt
 * route asks this; reading the session stays behind ordinary visibility.
 */
export async function sessionMayMessage(
  fromSessionId: string,
  toSessionId: string,
  projectId: string,
): Promise<typeof projectSessions.$inferSelect | null> {
  const [from] = await db
    .select({ parentSessionId: projectSessions.parentSessionId })
    .from(projectSessions)
    .where(and(eq(projectSessions.sessionId, fromSessionId), eq(projectSessions.projectId, projectId)))
    .limit(1);
  if (!from) return null;
  let allowed = from.parentSessionId === toSessionId;
  if (!allowed) {
    const [messaged] = await db
      .select({ one: sql<number>`1` })
      .from(sessionLifecycleCommands)
      .where(and(
        eq(sessionLifecycleCommands.sessionId, fromSessionId),
        eq(sessionLifecycleCommands.commandType, 'continue_session'),
        sql`${sessionLifecycleCommands.payload}->>'authorSessionId' = ${toSessionId}`,
      ))
      .limit(1);
    allowed = !!messaged;
  }
  if (!allowed) return null;
  const [to] = await db
    .select()
    .from(projectSessions)
    .where(and(eq(projectSessions.sessionId, toSessionId), eq(projectSessions.projectId, projectId)))
    .limit(1);
  return to ?? null;
}
