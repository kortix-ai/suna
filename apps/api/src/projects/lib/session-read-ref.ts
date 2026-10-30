import { projectSessions } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { db } from '../../shared/db';
import { isUuid } from '../../shared/validate';
import { mirrorHoldsBranch } from '../git/mirror';
import type { GitBackedProject } from '../git/types';

/**
 * The ref a repository read uses for the ref a client asked for.
 *
 * A session's branch is named by its session id and reaches the remote with
 * the session's first push or change request. Session create no longer pushes
 * it (2026-10-30), so before that push the session's files are its base: the
 * box checked the base out and branched locally. A read at a session id the
 * mirror does not hold reads that session's base ref instead, so a parked
 * session's Files view shows the tree, not "empty".
 *
 * Any other ref, and a session branch the remote has, is returned as asked.
 * A session branch pushed moments ago counts (`mirrorHoldsBranch` fetches it).
 */
export async function sessionReadRef(project: GitBackedProject, ref: string): Promise<string> {
  if (!isUuid(ref)) return ref;
  try {
    if (await mirrorHoldsBranch(project, ref)) return ref;
  } catch {
    // The read reports the mirror failure itself.
    return ref;
  }
  const [session] = await db
    .select({ baseRef: projectSessions.baseRef })
    .from(projectSessions)
    .where(
      and(
        eq(projectSessions.projectId, project.projectId),
        eq(projectSessions.sessionId, ref),
        eq(projectSessions.branchName, ref),
      ),
    )
    .limit(1);
  return session ? session.baseRef || project.defaultBranch : ref;
}
