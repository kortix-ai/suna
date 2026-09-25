import { and, eq } from 'drizzle-orm';
import { chatThreads, projectSessions } from '@kortix/db';
import { db } from '../../shared/db';

/**
 * Thread → session binding for every chat channel.
 *
 * A chat thread (a Slack thread, a Teams conversation, an email thread) maps
 * to exactly one Kortix session in exactly one project: `chat_threads` is
 * unique on (platform, workspace, thread) across every project. A reply in the
 * thread is delivered into that session, so it runs under that project's
 * access rules, whatever project the channel resolves to today.
 */
export interface ChatThreadKey {
  /** `slack`, `teams`, `email`, or `telegram` (the `chat_threads.platform` column). */
  platform: string;
  /** Slack team, Teams tenant, or AgentMail inbox. */
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
 * keeps its session.
 */
export async function bindChatThread(key: ChatThreadKey & { projectId: string; sessionId: string }): Promise<void> {
  await db
    .insert(chatThreads)
    .values({
      projectId: key.projectId,
      platform: key.platform,
      workspaceId: key.workspaceId,
      threadId: key.threadId,
      sessionId: key.sessionId,
    })
    .onConflictDoNothing({ target: [chatThreads.platform, chatThreads.workspaceId, chatThreads.threadId] });
}

/** Record a delivered message on the thread. */
export async function touchChatThread(key: ChatThreadKey): Promise<void> {
  await db.update(chatThreads).set({ lastMessageAt: new Date() }).where(threadRow(key));
}

/** Drop a mapping whose session is gone, so the next message starts a new session. */
export async function dropChatThread(key: ChatThreadKey): Promise<void> {
  await db.delete(chatThreads).where(threadRow(key));
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
