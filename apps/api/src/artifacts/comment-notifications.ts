import { artifactComments, artifactCommentThreads, artifacts, notifications } from '@kortix/db';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { filterArtifactRecipients } from '../notifications/access';
import { deliver } from '../notifications/notifier';
import { db } from '../shared/db';

/** Re-read customer data and access when the durable job runs. Its payload holds ids only. */
export async function notifyArtifactComment(input: { artifactId: string; commentId: string }): Promise<void> {
  const [source] = await db.select({ artifact: artifacts, thread: artifactCommentThreads, comment: artifactComments })
    .from(artifactComments)
    .innerJoin(artifactCommentThreads, eq(artifactCommentThreads.threadId, artifactComments.threadId))
    .innerJoin(artifacts, and(eq(artifacts.artifactId, artifactCommentThreads.artifactId), eq(artifacts.projectId, artifactCommentThreads.projectId)))
    .where(and(eq(artifactComments.commentId, input.commentId), eq(artifacts.artifactId, input.artifactId)));
  if (!source || source.comment.deletedAt) return;
  const comments = await db.select({ id: artifactComments.commentId, userId: artifactComments.authorUserId, deletedAt: artifactComments.deletedAt })
    .from(artifactComments).where(eq(artifactComments.threadId, source.thread.threadId))
    .orderBy(asc(artifactComments.createdAt), asc(artifactComments.commentId));
  if (!comments.length || comments[0]!.deletedAt) return;
  const mentioned = Array.isArray(source.comment.mentions) ? source.comment.mentions.flatMap((mention) => {
    if (!mention || typeof mention !== 'object') return [];
    const value = mention as { kind?: unknown; user_id?: unknown };
    return value.kind === 'user' && typeof value.user_id === 'string' ? [value.user_id] : [];
  }) : [];
  const candidates = comments[0]?.id === input.commentId
    ? [source.artifact.createdByUserId, ...mentioned]
    : [...comments.flatMap((comment) => comment.userId ? [comment.userId] : []), ...mentioned];
  const recipients = await filterArtifactRecipients(source.artifact, candidates.filter((id) => id !== source.comment.authorUserId));
  if (!recipients.length) return;
  const dedupeKey = `artifact-comments:${source.thread.threadId}:${source.comment.commentId}`;
  await deliver({
    kind: 'artifact_comment', accountId: source.artifact.accountId, projectId: source.artifact.projectId,
    artifactId: source.artifact.artifactId, artifactThreadId: source.thread.threadId,
    actorUserId: source.comment.authorUserId, title: source.artifact.title,
    body: 'New feedback in an Artifact comment thread.', dedupeKey, recipients,
  });
  const stored = await db.select({ userId: notifications.userId }).from(notifications)
    .where(and(eq(notifications.dedupeKey, dedupeKey), inArray(notifications.userId, recipients)));
  if (new Set(stored.map((row) => row.userId)).size !== recipients.length) throw new Error('Artifact notification inbox delivery is incomplete');
}
