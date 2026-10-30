import { artifactComments, artifactCommentThreads, artifacts, artifactCommentScreenshotObjects } from '@kortix/db';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '../shared/db';
import { canView } from './service';
import type { ArtifactCommentAccess } from './comments-service';
import { artifactScreenshotStore, screenshotKeyMatches, screenshotNotFound } from './comment-screenshot-storage';

export async function readArtifactCommentScreenshot(access: ArtifactCommentAccess, commentId: string) {
  const [row] = await db.select({ comment: artifactComments, artifact: artifacts })
    .from(artifactComments)
    .innerJoin(artifactCommentThreads, eq(artifactCommentThreads.threadId, artifactComments.threadId))
    .innerJoin(artifacts, eq(artifacts.artifactId, artifactCommentThreads.artifactId))
    .where(and(eq(artifactComments.commentId, commentId), eq(artifacts.artifactId, access.artifact.artifactId), eq(artifacts.projectId, access.artifact.projectId), eq(artifacts.accountId, access.artifact.accountId)));
  if (!row || !canView(row.artifact, access.viewer) || row.comment.deletedAt || !row.comment.screenshotKey || !screenshotKeyMatches(row.comment.screenshotKey, access.artifact.projectId, commentId)) throw screenshotNotFound();
  const [root] = await db.select({ deleted: artifactComments.deletedAt }).from(artifactComments)
    .where(eq(artifactComments.threadId, row.comment.threadId)).orderBy(asc(artifactComments.createdAt), asc(artifactComments.commentId)).limit(1);
  if (!root || root.deleted) throw screenshotNotFound();
  const [receipt] = await db.select({ key: artifactCommentScreenshotObjects.objectKey }).from(artifactCommentScreenshotObjects)
    .where(and(eq(artifactCommentScreenshotObjects.objectKey, row.comment.screenshotKey), eq(artifactCommentScreenshotObjects.commentId, commentId), eq(artifactCommentScreenshotObjects.state, 'attached')));
  if (!receipt) throw screenshotNotFound();
  return (await artifactScreenshotStore()).read(receipt.key);
}
