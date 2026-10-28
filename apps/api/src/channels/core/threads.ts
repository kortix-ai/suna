import { and, eq, sql } from 'drizzle-orm';
import { chatEventDedup, chatThreads, projectSessions } from '@kortix/db';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';

/**
 * Thread → session binding for every chat channel.
 *
 * A chat thread (one conversation on a chat platform) maps
 * to exactly one Kortix session in exactly one project: `chat_threads` is
 * unique on (platform, workspace, thread) across every project. A reply in the
 * thread is delivered into that session, so it runs under that project's
 * access rules, whatever project the channel resolves to today.
 */
export interface ChatThreadKey {
  /** One of `CHANNEL_PLATFORMS` (the `chat_threads.platform` column). */
  platform: string;
  /** The platform install the thread belongs to (a workspace, a tenant, an inbox or a bot). */
  workspaceId: string;
  threadId: string;
}

function threadRow(key: ChatThreadKey, projectId?: string) {
  return and(
    eq(chatThreads.platform, key.platform),
    eq(chatThreads.workspaceId, key.workspaceId),
    eq(chatThreads.threadId, key.threadId),
    projectId ? eq(chatThreads.projectId, projectId) : undefined,
  );
}

/** The thread's session and project. With `projectId`, only a thread of that project counts. */
export async function findChatThread(
  key: ChatThreadKey,
  projectId?: string,
): Promise<{ sessionId: string; projectId: string } | null> {
  if (!key.workspaceId || !key.threadId) return null;
  const [row] = await db
    .select({ sessionId: chatThreads.sessionId, projectId: chatThreads.projectId })
    .from(chatThreads)
    .where(threadRow(key, projectId))
    .limit(1);
  return row ?? null;
}

export interface ChatThreadSession {
  sessionId: string;
  projectId: string;
  createdBy: string | null;
  metadata: unknown;
  status: string | null;
  agentName: string | null;
}

/** The thread's live session row (owner, metadata, status); null when the session row is gone. */
export async function findChatThreadSession(
  key: ChatThreadKey,
  projectId?: string,
): Promise<ChatThreadSession | null> {
  const [row] = await db
    .select({
      sessionId: chatThreads.sessionId,
      projectId: chatThreads.projectId,
      createdBy: projectSessions.createdBy,
      metadata: projectSessions.metadata,
      status: projectSessions.status,
      agentName: projectSessions.agentName,
    })
    .from(chatThreads)
    .innerJoin(projectSessions, eq(projectSessions.sessionId, chatThreads.sessionId))
    .where(threadRow(key, projectId))
    .limit(1);
  return row ?? null;
}

/**
 * Map a thread to a session. The first mapping wins: a thread already bound
 * keeps its session. Returns the thread's owner after the write, so a caller
 * can tell "bound to me" from "already bound elsewhere".
 */
export async function bindChatThread(
  key: ChatThreadKey & { projectId: string; sessionId: string },
): Promise<{ sessionId: string; projectId: string } | null> {
  const [inserted] = await db
    .insert(chatThreads)
    .values({
      projectId: key.projectId,
      platform: key.platform,
      workspaceId: key.workspaceId,
      threadId: key.threadId,
      sessionId: key.sessionId,
    })
    .onConflictDoNothing({ target: [chatThreads.platform, chatThreads.workspaceId, chatThreads.threadId] })
    .returning({ sessionId: chatThreads.sessionId, projectId: chatThreads.projectId });
  return inserted ?? (await findChatThread(key));
}

/**
 * Move every thread bound to one session of a project to another: a successor
 * session takes over its failed predecessor's conversations, so replies in
 * those threads reach it. Returns the number of threads moved.
 */
export async function adoptChatThreads(projectId: string, fromSessionId: string, toSessionId: string): Promise<number> {
  const moved = await db
    .update(chatThreads)
    .set({ sessionId: toSessionId })
    .where(and(eq(chatThreads.projectId, projectId), eq(chatThreads.sessionId, fromSessionId)))
    .returning({ threadId: chatThreads.threadId });
  return moved.length;
}

/** Record a delivered message on the thread. */
export async function touchChatThread(key: ChatThreadKey): Promise<void> {
  await db.update(chatThreads).set({ lastMessageAt: new Date() }).where(threadRow(key));
}

/**
 * Drop a thread's mapping so the next message starts a new session. With
 * `sessionId`, only while the thread still maps to that session: a racing
 * message may have bound a new session since the caller read the row.
 */
export async function dropChatThread(key: ChatThreadKey, sessionId?: string): Promise<void> {
  await db
    .delete(chatThreads)
    .where(sessionId ? and(threadRow(key), eq(chatThreads.sessionId, sessionId)) : threadRow(key));
}

/** A claim outlives a create that never finishes (a crash) by at most this long. */
const CREATE_CLAIM_TTL_MS = 10 * 60_000;

/**
 * Claim the first create of a thread. An expired claim (a create that never
 * finished) is taken over in the same statement. Returns the owner token for
 * `releaseThreadCreate`, or null while another create holds it. A DB error
 * throws: no create runs unclaimed.
 */
export async function claimThreadCreate(key: string): Promise<Date | null> {
  const expiresAt = new Date(Date.now() + CREATE_CLAIM_TTL_MS);
  const rows = await db
    .insert(chatEventDedup)
    .values({ eventId: key, expiresAt })
    .onConflictDoUpdate({
      target: chatEventDedup.eventId,
      set: { expiresAt },
      setWhere: sql`${chatEventDedup.expiresAt} < now()`,
    })
    .returning({ eventId: chatEventDedup.eventId });
  return rows.length > 0 ? expiresAt : null;
}

/** Release only our own claim: after a takeover, the row belongs to the new owner. */
export async function releaseThreadCreate(key: string, token: Date): Promise<void> {
  await db.delete(chatEventDedup).where(and(eq(chatEventDedup.eventId, key), eq(chatEventDedup.expiresAt, token)));
}

/**
 * Free the thread-create claim a channel create carries (`bind_chat_thread.createClaim`):
 * the lifecycle calls it after the bind, and when it gives the create up. A
 * claim another create took over stays. Never throws: a claim left behind expires.
 */
export async function releaseCreateClaims(
  actions: ReadonlyArray<{ type: string; createClaim?: { key: string; token: string } }> | undefined,
): Promise<void> {
  for (const action of actions ?? []) {
    if (action.type !== 'bind_chat_thread' || !action.createClaim) continue;
    const { key, token } = action.createClaim;
    await releaseThreadCreate(key, new Date(token)).catch((error) =>
      logger.warn('[channel] thread create claim not released; it expires', { key, error: String(error) }));
  }
}

export type FollowUpRoute = { kind: 'here' } | { kind: 'thread_project'; projectId: string } | { kind: 'refused' };

/**
 * Where a message in a known thread runs, for a request that resolved to
 * `projectId`. A thread owned by another project runs there, under that
 * project's access check (after `/kortix use` re-points a channel, its older
 * threads stay with their project). A per-project app (`ownThreadsOnly`)
 * reaches only its own project, so it refuses such a thread.
 */
export function followUpRoute(
  threadProjectId: string | null | undefined,
  projectId: string,
  opts: { ownThreadsOnly?: boolean } = {},
): FollowUpRoute {
  if (!threadProjectId || threadProjectId === projectId) return { kind: 'here' };
  if (opts.ownThreadsOnly) return { kind: 'refused' };
  return { kind: 'thread_project', projectId: threadProjectId };
}
