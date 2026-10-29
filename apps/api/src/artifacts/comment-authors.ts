import { projectSessions } from '@kortix/db';
import { and, eq, inArray } from 'drizzle-orm';
import { resolveUserIdentities } from '../projects/surface';
import { db } from '../shared/db';

export type ArtifactCommentAuthor =
  | { kind: 'user'; user_id: string; name: string }
  | { kind: 'session'; session_id: string; agent_name: string; title: string | null };

export async function hydrateCommentAuthors<T extends { author_user_id: string | null; author_session_id: string | null }>(
  scope: { accountId: string; projectId: string }, comments: T[],
): Promise<Array<T & { author: ArtifactCommentAuthor }>> {
  if (!comments.length) return [];
  const userIds = [...new Set(comments.flatMap((comment) => comment.author_user_id ? [comment.author_user_id] : []))];
  const sessionIds = [...new Set(comments.flatMap((comment) => comment.author_session_id ? [comment.author_session_id] : []))];
  const [users, sessions] = await Promise.all([
    resolveUserIdentities(userIds),
    sessionIds.length ? db.select({ id: projectSessions.sessionId, agentName: projectSessions.agentName, metadata: projectSessions.metadata })
      .from(projectSessions).where(and(eq(projectSessions.accountId, scope.accountId), eq(projectSessions.projectId, scope.projectId), inArray(projectSessions.sessionId, sessionIds))) : [],
  ]);
  const bySession = new Map(sessions.map((session) => [session.id, session]));
  return comments.map((comment) => {
    let author: ArtifactCommentAuthor;
    if (comment.author_session_id) {
      const session = bySession.get(comment.author_session_id);
      const metadata = session?.metadata as Record<string, unknown> | null | undefined;
      const title = [metadata?.custom_name, metadata?.name].find((value): value is string => typeof value === 'string' && !!value.trim()) ?? null;
      author = { kind: 'session', session_id: comment.author_session_id, agent_name: session?.agentName ?? 'unknown', title };
    } else {
      const userId = comment.author_user_id!;
      const user = users.get(userId);
      author = { kind: 'user', user_id: userId, name: user?.displayName?.trim() || user?.email || 'Former user' };
    }
    return { ...comment, author };
  });
}
