/**
 * Who wrote each message of a session. The live runtime does not know: an
 * OpenCode user message has no author. The prompt ledger does — every row a
 * person or an agent sent through `POST .../prompts` (or a create's first
 * prompt) carries the authenticated sender. Never inferred from the owner.
 */
import { projectSessions, sessionLifecycleCommands, sessionTurns } from '@kortix/db';
import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { db } from '../../shared/db';
import { resolveUserIdentities } from './user-identity';

export type SessionMessageAuthor =
  | { kind: 'member'; user_id: string; name: string; email: string | null; avatar_url: string | null }
  | { kind: 'session'; session_id: string; name: string; agent?: string };

export interface SessionMessageAuthors {
  /** Keyed by every runtime message id the prompt travelled under. */
  authors: Record<string, SessionMessageAuthor>;
  /** A spawned session's first message came from its parent's agent through
   *  `initial_prompt`, which leaves no ledger row. Null otherwise. */
  initial_author: SessionMessageAuthor | null;
  /** Who stopped each stopped turn, keyed by the message id that started it:
   *  clients show "Stopped by <name>". Only a stop a person asked for and the
   *  ledger names (`end_error.by`). Empty when there is none. */
  stops: Record<string, SessionMessageAuthor>;
}

/** The agent a session runs, unless it is the column's `'default'` placeholder. */
function namedAgent(agentName: string | null | undefined): agentName is string {
  return !!agentName && agentName !== 'default';
}

function sessionTitle(metadata: unknown): string {
  const meta = (metadata ?? {}) as Record<string, unknown>;
  return [meta.custom_name, meta.name].find((v): v is string => typeof v === 'string' && !!v.trim()) ?? 'Untitled session';
}

export async function sessionMessageAuthors(session: {
  sessionId: string;
  projectId: string;
  parentSessionId: string | null;
  metadata: unknown;
}): Promise<SessionMessageAuthors> {
  const [rows, stopRows] = await Promise.all([
    db
      .select({
        userId: sessionLifecycleCommands.actorUserId,
        payload: sessionLifecycleCommands.payload,
        result: sessionLifecycleCommands.result,
      })
      .from(sessionLifecycleCommands)
      .where(and(
        eq(sessionLifecycleCommands.sessionId, session.sessionId),
        eq(sessionLifecycleCommands.commandType, 'continue_session'),
        // Inbox rows only: triggers, reminders and channel relays speak for
        // themselves in their text and carry no human sender.
        sql`${sessionLifecycleCommands.payload} ? 'clientMessageId'`,
      )),
    // Ended turns a person stopped (`markTurnStopRequested` with `by`).
    db
      .select({ messageId: sessionTurns.messageId, endError: sessionTurns.endError })
      .from(sessionTurns)
      .where(and(
        eq(sessionTurns.sessionId, session.sessionId),
        eq(sessionTurns.state, 'ended'),
        isNotNull(sessionTurns.messageId),
        sql`${sessionTurns.endError}->>'name' = 'UserStop'`,
        sql`${sessionTurns.endError}->>'by' IS NOT NULL`,
      )),
  ]);
  const initialFromParent = !!session.parentSessionId &&
    typeof (session.metadata as Record<string, unknown> | null)?.initial_prompt === 'string';
  const sessionIds = new Set<string>(initialFromParent ? [session.parentSessionId!] : []);
  const userIds = new Set<string>();
  for (const row of rows) {
    const author = (row.payload as Record<string, unknown>).authorSessionId;
    if (typeof author === 'string') sessionIds.add(author);
    else if (row.userId) userIds.add(row.userId);
  }
  for (const row of stopRows) if (row.endError?.by) userIds.add(row.endError.by);
  const [titles, identities] = await Promise.all([
    sessionIds.size > 0
      ? db
          .select({ sessionId: projectSessions.sessionId, metadata: projectSessions.metadata, agentName: projectSessions.agentName })
          .from(projectSessions)
          .where(and(inArray(projectSessions.sessionId, [...sessionIds]), eq(projectSessions.projectId, session.projectId)))
      : Promise.resolve([]),
    resolveUserIdentities([...userIds]),
  ]);
  const sessionById = new Map(titles.map((row) => [row.sessionId, row]));
  const sessionAuthor = (id: string): SessionMessageAuthor | null => {
    const row = sessionById.get(id);
    if (!row) return null;
    return { kind: 'session', session_id: id, name: sessionTitle(row.metadata), ...(namedAgent(row.agentName) ? { agent: row.agentName } : {}) };
  };

  const memberAuthor = (userId: string): SessionMessageAuthor | null => {
    const identity = identities.get(userId);
    if (!identity?.exists) return null;
    return {
      kind: 'member',
      user_id: userId,
      name: identity.displayName?.trim() || identity.email || 'Member',
      email: identity.email,
      avatar_url: identity.avatarUrl ?? null,
    };
  };

  const stops: Record<string, SessionMessageAuthor> = {};
  for (const row of stopRows) {
    const stopper = row.messageId && row.endError?.by ? memberAuthor(row.endError.by) : null;
    if (stopper) stops[row.messageId!] = stopper;
  }

  const authors: Record<string, SessionMessageAuthor> = {};
  for (const row of rows) {
    const payload = row.payload as Record<string, unknown>;
    const result = row.result as Record<string, unknown>;
    let author: SessionMessageAuthor | null = null;
    if (typeof payload.authorSessionId === 'string') author = sessionAuthor(payload.authorSessionId);
    else if (row.userId) author = memberAuthor(row.userId);
    if (!author) continue;
    const ids = [payload.wireMessageId, payload.redeliveredMessageId, result.forwarded_message_id,
      ...(Array.isArray(payload.redeliveredMessageIds) ? payload.redeliveredMessageIds : [])];
    for (const id of ids) if (typeof id === 'string' && id) authors[id] = author;
  }
  if (!initialFromParent) return { authors, initial_author: null, stops };
  // The `initial_prompt` turn is the session's first: its message id is known.
  const [first] = await db
    .select({ messageId: sessionTurns.messageId })
    .from(sessionTurns)
    .where(and(eq(sessionTurns.sessionId, session.sessionId), isNotNull(sessionTurns.messageId)))
    .orderBy(asc(sessionTurns.createdAt))
    .limit(1);
  const parent = sessionAuthor(session.parentSessionId!);
  if (first?.messageId && parent && !authors[first.messageId]) {
    authors[first.messageId] = parent;
    return { authors, initial_author: null, stops };
  }
  return { authors, initial_author: parent, stops };
}
