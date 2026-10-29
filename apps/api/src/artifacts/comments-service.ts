import { artifactCommentThreads, artifactComments, artifactCommentWriteLimits, artifacts } from '@kortix/db';
import { artifactCommentAnchorSchema, reanchorArtifactText, type ArtifactCommentAnchor } from '@kortix/shared/artifact-comments';
import { and, asc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { Actor } from '../iam/actor';
import { db } from '../shared/db';
import { canView, readArtifactFile, type ArtifactRow, type Viewer } from './service';
import { recordArtifactEvent } from './events-store';
import { hydrateCommentAuthors } from './comment-authors';

export class ArtifactCommentError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 429, message: string, readonly code: string, readonly retryAfterSeconds = 60) {
    super(message);
    this.name = 'ArtifactCommentError';
  }
}

export interface ArtifactCommentAccess {
  artifact: ArtifactRow;
  viewer: Viewer;
  sessionId: string | null;
  canEdit: boolean;
}

type Thread = typeof artifactCommentThreads.$inferSelect;
type Comment = typeof artifactComments.$inferSelect;
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type CommentStatus = 'open' | 'resolved';

const forbidden = () => new ArtifactCommentError(403, 'You cannot change this comment thread', 'artifact_comment_forbidden');
const deleted = () => new ArtifactCommentError(409, 'This comment thread was deleted', 'thread_deleted');

function author(actor: Actor, access: ArtifactCommentAccess) {
  return access.sessionId
    ? { userId: null, sessionId: access.sessionId }
    : { userId: actor.userId, sessionId: null };
}

function own(actor: Actor, access: ArtifactCommentAccess, userId: string | null, sessionId: string | null): boolean {
  return access.sessionId ? sessionId === access.sessionId : userId === actor.userId && sessionId === null;
}

function bodyText(body: string): string {
  if (!body.trim() || body.length > 10_000 || body.includes('\0')) {
    throw new ArtifactCommentError(400, 'A comment needs 1 to 10,000 characters without NUL', 'invalid_comment');
  }
  return body;
}

function commentView(row: Comment) {
  return {
    comment_id: row.commentId,
    thread_id: row.threadId,
    author_user_id: row.authorUserId,
    author_session_id: row.authorSessionId,
    body: row.deletedAt ? '' : row.body,
    mentions: row.deletedAt ? [] : row.mentions,
    marks: row.deletedAt ? [] : row.marks,
    screenshot_key: row.deletedAt ? null : row.screenshotKey,
    created_at: row.createdAt.toISOString(),
    edited_at: row.editedAt?.toISOString() ?? null,
    deleted_at: row.deletedAt?.toISOString() ?? null,
  };
}

function threadView(row: Thread, comments: Comment[], text?: string) {
  const anchor = row.anchor as ArtifactCommentAnchor;
  const position = text !== undefined && anchor.type === 'text' ? reanchorArtifactText(text, anchor) : null;
  return {
    thread_id: row.threadId,
    artifact_id: row.artifactId,
    project_id: row.projectId,
    anchor,
    anchor_version: row.anchorVersion,
    created_by_user_id: row.createdByUserId,
    created_by_session_id: row.createdBySessionId,
    status: row.status,
    resolved_by_user_id: row.resolvedByUserId,
    resolved_by_session_id: row.resolvedBySessionId,
    resolved_at: row.resolvedAt?.toISOString() ?? null,
    agent_state: row.agentState,
    sent_session_id: row.sentSessionId,
    sent_at: row.sentAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    comments: comments.map(commentView),
    outdated: position?.outdated ?? false,
    position: position && position.start !== null && position.end !== null ? { start: position.start, end: position.end } : null,
  };
}

async function hydrateThreads(access: ArtifactCommentAccess, threads: ReturnType<typeof threadView>[]) {
  const comments = await hydrateCommentAuthors(access.artifact, threads.flatMap((thread) => thread.comments));
  const byId = new Map(comments.map((comment) => [comment.comment_id, comment]));
  return threads.map((thread) => ({ ...thread, comments: thread.comments.map((comment) => byId.get(comment.comment_id)!) }));
}

async function readThreads(access: ArtifactCommentAccess, status: CommentStatus | 'all', threadId?: string) {
  const threads = await db.select().from(artifactCommentThreads)
    .where(and(eq(artifactCommentThreads.artifactId, access.artifact.artifactId), eq(artifactCommentThreads.projectId, access.artifact.projectId),
      status === 'all' ? undefined : eq(artifactCommentThreads.status, status), threadId ? eq(artifactCommentThreads.threadId, threadId) : undefined))
    .orderBy(asc(artifactCommentThreads.createdAt), asc(artifactCommentThreads.threadId));
  if (!threads.length) return [];
  const comments = await db.select().from(artifactComments)
    .where(inArray(artifactComments.threadId, threads.map((t) => t.threadId)))
    .orderBy(asc(artifactComments.createdAt), asc(artifactComments.commentId));
  const text = access.artifact.type === 'doc' && threads.some((t) => (t.anchor as ArtifactCommentAnchor).type === 'text')
    ? await (await readArtifactFile(access.artifact, access.artifact.entry)).text()
    : undefined;
  return hydrateThreads(access, threads.map((thread) => threadView(thread, comments.filter((c) => c.threadId === thread.threadId), text)));
}

export async function listArtifactCommentThreads(access: ArtifactCommentAccess, status: CommentStatus | 'all') {
  return readThreads(access, status);
}

export async function getArtifactCommentThread(access: ArtifactCommentAccess, threadId: string) {
  const [thread] = await readThreads(access, 'all', threadId);
  if (!thread) throw new ArtifactCommentError(404, 'Comment thread not found', 'not_found');
  return thread;
}

export async function artifactIdForCommentThread(projectId: string, threadId: string): Promise<string | null> {
  const [thread] = await db.select({ artifactId: artifactCommentThreads.artifactId }).from(artifactCommentThreads)
    .innerJoin(artifacts, and(eq(artifacts.artifactId, artifactCommentThreads.artifactId), eq(artifacts.projectId, artifactCommentThreads.projectId)))
    .where(and(eq(artifactCommentThreads.projectId, projectId), eq(artifactCommentThreads.threadId, threadId)));
  return thread?.artifactId ?? null;
}

async function writeQuota(tx: Transaction, actor: Actor, access: ArtifactCommentAccess): Promise<void> {
  const limits = artifactCommentWriteLimits;
  const [limit] = await tx.insert(limits).values({
    artifactId: access.artifact.artifactId,
    actorKey: access.sessionId ? `session:${access.sessionId}` : `user:${actor.userId}`,
    windowStartedAt: sql`now()`,
    writes: 1,
  }).onConflictDoUpdate({
    target: [limits.artifactId, limits.actorKey],
    set: {
      windowStartedAt: sql`case when ${limits.windowStartedAt} <= now() - interval '1 minute' then now() else ${limits.windowStartedAt} end`,
      writes: sql`case when ${limits.windowStartedAt} <= now() - interval '1 minute' then 1 else ${limits.writes} + 1 end`,
    },
  }).returning({ writes: limits.writes });
  if (limit!.writes > 60) {
    throw new ArtifactCommentError(429, 'At most 60 comment writes per minute per author per Artifact', 'artifact_comment_rate_limited');
  }
}

async function sessionCommentQuota(tx: Transaction, access: ArtifactCommentAccess): Promise<void> {
  if (!access.sessionId) return;
  const [row] = await tx.select({ count: sql<number>`count(*)::int` }).from(artifactComments)
    .innerJoin(artifactCommentThreads, eq(artifactCommentThreads.threadId, artifactComments.threadId))
    .where(and(
      eq(artifactCommentThreads.artifactId, access.artifact.artifactId),
      eq(artifactComments.authorSessionId, access.sessionId),
      gte(artifactComments.createdAt, sql`now() - interval '1 hour'`),
    ));
  if ((row?.count ?? 0) >= 30) {
    throw new ArtifactCommentError(429, 'A session can write at most 30 comments per hour per Artifact', 'artifact_comment_rate_limited', 3600);
  }
}

async function write<T>(actor: Actor, access: ArtifactCommentAccess, apply: (tx: Transaction) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    // ponytail: one short row lock per Artifact serializes quotas and deletes; use per-author locks if contention is measured.
    const [artifact] = await tx.select().from(artifacts)
      .where(and(eq(artifacts.artifactId, access.artifact.artifactId), eq(artifacts.projectId, access.artifact.projectId)))
      .for('update');
    if (!artifact || !canView(artifact, access.viewer)) throw new ArtifactCommentError(404, 'Artifact not found', 'not_found');
    await writeQuota(tx, actor, access);
    return apply(tx);
  });
}

async function loadThread(tx: Transaction, access: ArtifactCommentAccess, threadId: string): Promise<Thread> {
  const [thread] = await tx.select().from(artifactCommentThreads)
    .where(and(eq(artifactCommentThreads.artifactId, access.artifact.artifactId), eq(artifactCommentThreads.threadId, threadId)));
  if (!thread) throw new ArtifactCommentError(404, 'Comment thread not found', 'not_found');
  const [root] = await tx.select({ deletedAt: artifactComments.deletedAt }).from(artifactComments)
    .where(eq(artifactComments.threadId, threadId))
    .orderBy(asc(artifactComments.createdAt), asc(artifactComments.commentId)).limit(1);
  if (!root || root.deletedAt) throw deleted();
  return thread;
}

export async function createArtifactCommentThread(actor: Actor, access: ArtifactCommentAccess, input: { anchor?: unknown; body: string }) {
  const parsed = artifactCommentAnchorSchema.safeParse(input.anchor);
  if (!parsed.success || (access.artifact.type === 'doc' && parsed.data.type !== 'text' && parsed.data.type !== 'none')) {
    throw new ArtifactCommentError(400, 'Invalid comment anchor', 'invalid_anchor');
  }
  const body = bodyText(input.body);
  const who = author(actor, access);
  const thread = await write(actor, access, async (tx) => {
    await sessionCommentQuota(tx, access);
    const [thread] = await tx.insert(artifactCommentThreads).values({
      artifactId: access.artifact.artifactId,
      projectId: access.artifact.projectId,
      anchor: parsed.data,
      anchorVersion: parsed.data.version,
      createdByUserId: who.userId,
      createdBySessionId: who.sessionId,
    }).returning();
    const [comment] = await tx.insert(artifactComments).values({
      threadId: thread!.threadId,
      authorUserId: who.userId,
      authorSessionId: who.sessionId,
      body,
    }).returning();
    await recordArtifactEvent(tx, access.artifact, who, 'thread_opened', { thread_id: thread!.threadId, comment_id: comment!.commentId });
    return threadView(thread!, [comment!]);
  });
  return (await hydrateThreads(access, [thread]))[0]!;
}

export async function replyArtifactCommentThread(actor: Actor, access: ArtifactCommentAccess, threadId: string, body: string) {
  const text = bodyText(body);
  const who = author(actor, access);
  const comment = await write(actor, access, async (tx) => {
    await loadThread(tx, access, threadId);
    await sessionCommentQuota(tx, access);
    const [comment] = await tx.insert(artifactComments).values({
      threadId, body: text, authorUserId: who.userId, authorSessionId: who.sessionId,
    }).returning();
    await tx.update(artifactCommentThreads).set({ updatedAt: sql`now()` }).where(eq(artifactCommentThreads.threadId, threadId));
    await recordArtifactEvent(tx, access.artifact, who, 'replied', { thread_id: threadId, comment_id: comment!.commentId });
    return commentView(comment!);
  });
  return (await hydrateCommentAuthors(access.artifact, [comment]))[0]!;
}

export async function setArtifactCommentThreadStatus(actor: Actor, access: ArtifactCommentAccess, threadId: string, status: CommentStatus) {
  const thread = await write(actor, access, async (tx) => {
    const thread = await loadThread(tx, access, threadId);
    if (!own(actor, access, thread.createdByUserId, thread.createdBySessionId)
      && !access.viewer.manageAny && !(access.sessionId && thread.sentSessionId === access.sessionId)
      && !access.canEdit) throw forbidden();
    if (thread.status !== status) {
      const who = author(actor, access);
      const [updated] = await tx.update(artifactCommentThreads).set({
        status,
        resolvedByUserId: status === 'resolved' ? who.userId : null,
        resolvedBySessionId: status === 'resolved' ? who.sessionId : null,
        resolvedAt: status === 'resolved' ? sql`now()` : null,
        updatedAt: sql`now()`,
      }).where(eq(artifactCommentThreads.threadId, threadId)).returning();
      Object.assign(thread, updated!);
      await recordArtifactEvent(tx, access.artifact, who, status === 'resolved' ? 'resolved' : 'reopened', { thread_id: threadId });
    }
    const comments = await tx.select().from(artifactComments).where(eq(artifactComments.threadId, threadId))
      .orderBy(asc(artifactComments.createdAt), asc(artifactComments.commentId));
    return threadView(thread, comments);
  });
  return (await hydrateThreads(access, [thread]))[0]!;
}

export async function changeArtifactComment(actor: Actor, access: ArtifactCommentAccess, threadId: string, commentId: string, body: string | null) {
  const text = body === null ? null : bodyText(body);
  const comment = await write(actor, access, async (tx) => {
    await loadThread(tx, access, threadId);
    const [comment] = await tx.select().from(artifactComments)
      .where(and(eq(artifactComments.threadId, threadId), eq(artifactComments.commentId, commentId)));
    if (!comment) throw new ArtifactCommentError(404, 'Comment not found', 'not_found');
    if (comment.deletedAt) throw deleted();
    if (!own(actor, access, comment.authorUserId, comment.authorSessionId) && !(text === null && access.viewer.manageAny)) throw forbidden();
    const [updated] = await tx.update(artifactComments).set(text === null
      ? { body: '', mentions: [], marks: [], screenshotKey: null, deletedAt: sql`now()` }
      : { body: text, editedAt: sql`now()` })
      .where(eq(artifactComments.commentId, commentId)).returning();
    await tx.update(artifactCommentThreads).set({ updatedAt: sql`now()` }).where(eq(artifactCommentThreads.threadId, threadId));
    if (text === null) await recordArtifactEvent(tx, access.artifact, author(actor, access), 'comment_deleted', { thread_id: threadId, comment_id: commentId });
    return commentView(updated!);
  });
  return (await hydrateCommentAuthors(access.artifact, [comment]))[0]!;
}
