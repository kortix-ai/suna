import { artifactComments, artifactCommentThreads } from '@kortix/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { qualifiedColumn } from '../shared/sql-qualified-column';

/**
 * The open comment threads of each Artifact, in one grouped query for a whole
 * page of Artifacts. A thread counts while its status is `open` and its root
 * comment (the first by `created_at, comment_id`) is not deleted: the
 * `rootDeleted` rule of `comments-service.ts` and the viewer's open count.
 * A thread with no comment has no root and does not count. Every id maps to a
 * number; an Artifact without an open thread maps to 0.
 */
export async function openArtifactThreadCounts(projectId: string, artifactIds: readonly string[]): Promise<Map<string, number>> {
  const ids = [...new Set(artifactIds)];
  const counts = new Map(ids.map((id) => [id, 0]));
  if (!ids.length) return counts;
  // Qualified: inside the subquery a bare `thread_id` would bind to the comment row.
  const thread = qualifiedColumn(artifactCommentThreads.threadId);
  const rootKept = sql`(select c.deleted_at is null from ${artifactComments} c where c.thread_id = ${thread} order by c.created_at, c.comment_id limit 1)`;
  const rows = await db.select({ artifactId: artifactCommentThreads.artifactId, open: sql<number>`count(*)::int` })
    .from(artifactCommentThreads)
    .where(and(
      eq(artifactCommentThreads.projectId, projectId),
      inArray(artifactCommentThreads.artifactId, ids),
      eq(artifactCommentThreads.status, 'open'),
      rootKept,
    ))
    .groupBy(artifactCommentThreads.artifactId);
  for (const row of rows) counts.set(row.artifactId, row.open);
  return counts;
}
