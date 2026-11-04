// A person's front chat (flag `infinichat`): one endless My Kortix session per
// person and project, in which the agent only talks (front-chat-keys.ts).
import { projectSessionRuntimeContexts, projectSessions } from '@kortix/db';
import { MY_KORTIX_AGENT_NAME } from '@kortix/shared';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../../shared/db';
import { FRONT_CHAT_CONTEXT_KEY } from './front-chat-keys';

/**
 * The person's newest live front chat in the project, or null. A session is a
 * front chat only when its runtime_context carries `kortix.front`, which only
 * the platform sets: the metadata copy alone does not count.
 */
export async function findFrontChatSession(projectId: string, userId: string): Promise<string | null> {
  const [row] = await db
    .select({ sessionId: projectSessions.sessionId })
    .from(projectSessions)
    .innerJoin(projectSessionRuntimeContexts, eq(projectSessionRuntimeContexts.sessionId, projectSessions.sessionId))
    .where(and(
      eq(projectSessions.projectId, projectId),
      eq(projectSessions.createdBy, userId),
      eq(projectSessions.agentName, MY_KORTIX_AGENT_NAME),
      sql`(${projectSessionRuntimeContexts.context}->>${FRONT_CHAT_CONTEXT_KEY})::boolean is true`,
      sql`coalesce(${projectSessions.metadata}->>'deletedAt', '') = ''`,
    ))
    .orderBy(desc(projectSessions.createdAt))
    .limit(1);
  return row?.sessionId ?? null;
}

/** True when this session is a front chat: its worker is a My Kortix session it may start. */
export async function sessionIsFrontChat(sessionId: string): Promise<boolean> {
  const [row] = await db
    .select({ front: sql<boolean>`(${projectSessionRuntimeContexts.context}->>${FRONT_CHAT_CONTEXT_KEY})::boolean is true` })
    .from(projectSessionRuntimeContexts)
    .where(eq(projectSessionRuntimeContexts.sessionId, sessionId))
    .limit(1);
  return row?.front === true;
}
