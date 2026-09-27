import { and, desc, eq, sql } from 'drizzle-orm';
import { chatThreads, projectSessions, projects } from '@kortix/db';
import { db } from '../../shared/db';
import { authorize } from '../../iam';
import { actorForUser } from '../../iam/actor';
import { PROJECT_ACTIONS } from '../../iam/actions';
import { canAccessSandboxSession } from '../../shared/preview-ownership';
import { type ChatUser, isAccountMember, lookupChatIdentity } from './identity';

export interface ChatSessionListing {
  projectId: string;
  projectName: string;
  repoUrl: string;
  sessionId: string;
  lastMessageAt: Date;
}

/** How many recent threads are read to find `limit` the caller may open. */
const CANDIDATE_WINDOW = 50;

/**
 * The most recent sessions started from a chat workspace that `user` may
 * open on the web: the linked Kortix user must be able to read the project
 * and see the session (its visibility, grants, and account oversight — the
 * same rule the session routes apply). Null when `user` has no linked
 * account. `projectId` confines the list to one project (a per-project app).
 */
export async function listVisibleChatSessions(
  user: ChatUser,
  opts: { limit: number; projectId?: string },
): Promise<ChatSessionListing[] | null> {
  const identity = await lookupChatIdentity(user);
  if (!identity) return null;
  const rows = await db
    .select({
      projectId: chatThreads.projectId,
      sessionId: chatThreads.sessionId,
      lastMessageAt: chatThreads.lastMessageAt,
      accountId: projects.accountId,
      projectName: projects.name,
      repoUrl: projects.repoUrl,
    })
    .from(chatThreads)
    .innerJoin(projects, eq(projects.projectId, chatThreads.projectId))
    .innerJoin(projectSessions, eq(projectSessions.sessionId, chatThreads.sessionId))
    .where(
      and(
        eq(chatThreads.platform, user.platform),
        eq(chatThreads.workspaceId, user.workspaceId),
        opts.projectId ? eq(chatThreads.projectId, opts.projectId) : undefined,
        sql`${projectSessions.metadata}->>'deletedAt' IS NULL`,
      ),
    )
    .orderBy(desc(chatThreads.lastMessageAt))
    .limit(CANDIDATE_WINDOW);

  const projectReads = new Map<string, Promise<boolean>>();
  const mayReadProject = (projectId: string, accountId: string): Promise<boolean> => {
    let read = projectReads.get(projectId);
    if (!read) {
      read = (async () =>
        (await isAccountMember(identity.userId, accountId)) &&
        (
          await authorize(actorForUser(identity.userId, accountId), PROJECT_ACTIONS.PROJECT_READ, {
            type: 'project',
            id: projectId,
          })
        ).allowed)();
      projectReads.set(projectId, read);
    }
    return read;
  };

  const visible = await Promise.all(
    rows.map(
      async (row) =>
        (await mayReadProject(row.projectId, row.accountId)) &&
        (await canAccessSandboxSession({
          sessionId: row.sessionId,
          projectId: row.projectId,
          accountId: row.accountId,
          userId: identity.userId,
          callerSessionId: null,
          boundCredentialSessionId: null,
        })),
    ),
  );
  return rows
    .filter((_, i) => visible[i])
    .slice(0, opts.limit)
    .map(({ projectId, projectName, repoUrl, sessionId, lastMessageAt }) => ({
      projectId,
      projectName,
      repoUrl,
      sessionId,
      lastMessageAt,
    }));
}
