import { artifactCommentThreads, artifactComments, artifactCommentWriteLimits, artifacts } from '@kortix/db';
import { artifactCommentAnchorSchema, artifactCommentMarksSchema, reanchorArtifactText, type ArtifactCommentAnchor } from '@kortix/shared/artifact-comments';
import { and, asc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { Actor } from '../iam/actor';
import { db } from '../shared/db';
import { canView, entryVersion, readArtifactFile, type ArtifactRow, type Viewer } from './service';
import { recordArtifactEvent } from './events-store';
import { artifactCommentPermissions } from './comment-permissions';
import { hydrateCommentAuthors } from './comment-authors';
import { resolveArtifactCommentMentions } from './comment-mentions';
import { hydrateArtifactCommentMentions } from './comment-tokens';
import { dispatchArtifactCommentJobs, enqueueArtifactCommentRouting } from './comment-delivery';
import { randomUUID } from 'node:crypto';
import { prepareArtifactCommentScreenshot, attachArtifactCommentScreenshot, abandonArtifactCommentScreenshot, cleanupArtifactCommentScreenshotKeys } from './comment-screenshot-objects';

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
  canComment?: boolean;
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

function rights(access: ArtifactCommentAccess, creator: { userId: string | null; sessionId: string | null }, sentSessionId: string | null, deleted: boolean, historical: boolean) {
  return artifactCommentPermissions({ userId: access.viewer.userId, sessionId: access.sessionId, canComment: access.canComment ?? true,
    canEdit: access.canEdit, manageAny: access.viewer.manageAny ?? false }, creator, sentSessionId, deleted, historical);
}

function commentView(row: Comment, access: ArtifactCommentAccess, rootDeleted = false, historical = false) {
  return {
    ...rights(access, { userId: row.authorUserId, sessionId: row.authorSessionId }, null, rootDeleted, historical)
      .comment({ userId: row.authorUserId, sessionId: row.authorSessionId }, !!row.deletedAt),
    comment_id: row.commentId,
    thread_id: row.threadId,
    author_user_id: row.authorUserId,
    author_session_id: row.authorSessionId,
    body: row.deletedAt ? '' : row.body,
    mentions: row.deletedAt ? [] : hydrateArtifactCommentMentions(row.mentions),
    marks: row.deletedAt ? [] : row.marks,
    screenshot_key: row.deletedAt ? null : row.screenshotKey,
    ...(!row.deletedAt && row.screenshotKey ? { screenshot_url: `/projects/${access.artifact.projectId}/artifacts/${access.artifact.artifactId}/comments/${row.commentId}/screenshot` } : {}),
    created_at: row.createdAt.toISOString(),
    edited_at: row.editedAt?.toISOString() ?? null,
    deleted_at: row.deletedAt?.toISOString() ?? null,
  };
}

function threadView(row: Thread, comments: Comment[], access: ArtifactCommentAccess, text?: string, historical = false) {
  const rootDeleted = !comments.length || !!comments[0]!.deletedAt;
  const permissions = rights(access, { userId: row.createdByUserId, sessionId: row.createdBySessionId }, row.sentSessionId, rootDeleted, historical);
  const anchor = row.anchor as ArtifactCommentAnchor;
  const position = text !== undefined && anchor.type === 'text' ? reanchorArtifactText(text, anchor) : null;
  return {
    can_reply: permissions.can_reply,
    can_resolve: permissions.can_resolve,
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
    agent_error: row.agentError,
    sent_session_id: row.sentSessionId,
    sent_at: row.sentAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    comments: comments.map((comment) => commentView(comment, access, rootDeleted, historical)),
    outdated: position?.outdated ?? false,
    position: position && position.start !== null && position.end !== null ? { start: position.start, end: position.end } : null,
  };
}

async function hydrateThreads(access: ArtifactCommentAccess, threads: ReturnType<typeof threadView>[]) {
  const comments = await hydrateCommentAuthors(access.artifact, threads.flatMap((thread) => thread.comments));
  const byId = new Map(comments.map((comment) => [comment.comment_id, comment]));
  return threads.map((thread) => ({ ...thread, comments: thread.comments.map((comment) => byId.get(comment.comment_id)!) }));
}

async function readThreads(access: ArtifactCommentAccess, status: CommentStatus | 'all', threadId?: string, version?: string) {
  const selectedEntry = version ? await entryVersion(access.artifact, version) : null;
  if (version && !selectedEntry) throw new ArtifactCommentError(404, 'Artifact version not found', 'version_not_found');
  const rows = await db.select().from(artifactCommentThreads)
    .where(and(eq(artifactCommentThreads.artifactId, access.artifact.artifactId), eq(artifactCommentThreads.projectId, access.artifact.projectId),
      status === 'all' ? undefined : eq(artifactCommentThreads.status, status), threadId ? eq(artifactCommentThreads.threadId, threadId) : undefined))
    .orderBy(asc(artifactCommentThreads.createdAt), asc(artifactCommentThreads.threadId));
  const threads = version ? rows.filter((thread) => thread.anchorVersion === version || thread.anchorVersion === selectedEntry) : rows;
  if (!threads.length) return [];
  const comments = await db.select().from(artifactComments)
    .where(inArray(artifactComments.threadId, threads.map((t) => t.threadId)))
    .orderBy(asc(artifactComments.createdAt), asc(artifactComments.commentId));
  const text = access.artifact.type === 'doc' && threads.some((t) => (t.anchor as ArtifactCommentAnchor).type === 'text')
    ? await (await readArtifactFile(access.artifact, access.artifact.entry, version)).text()
    : undefined;
  return hydrateThreads(access, threads.map((thread) => threadView(thread, comments.filter((c) => c.threadId === thread.threadId), access, text, version !== undefined)));
}

export async function listArtifactCommentThreads(access: ArtifactCommentAccess, status: CommentStatus | 'all', version?: string) {
  return readThreads(access, status, undefined, version);
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

async function write<T>(actor: Actor, access: ArtifactCommentAccess, apply: (tx: Transaction) => Promise<T>, chargeQuota = true): Promise<T> {
  return db.transaction(async (tx) => {
    // ponytail: one short row lock per Artifact serializes quotas and deletes; use per-author locks if contention is measured.
    const [artifact] = await tx.select().from(artifacts)
      .where(and(eq(artifacts.artifactId, access.artifact.artifactId), eq(artifacts.projectId, access.artifact.projectId)))
      .for('update');
    if (!artifact || artifact.accountId !== actor.accountId || artifact.accountId !== access.artifact.accountId || !canView(artifact, access.viewer)) throw new ArtifactCommentError(404, 'Artifact not found', 'not_found');
    if (chargeQuota) await writeQuota(tx, actor, access);
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

export interface ArtifactCommentBodyInput { body: string; marks?: unknown; screenshot_base64?: unknown }
function marksFor(value: unknown, anchor: ArtifactCommentAnchor) {
  const parsed = artifactCommentMarksSchema.safeParse(value ?? []);
  if (!parsed.success || value === null || parsed.data.length && anchor.type !== 'region') {
    throw new ArtifactCommentError(400, 'Invalid comment marks', 'invalid_marks');
  }
  return parsed.data;
}

async function prepareImage(actor: Actor, access: ArtifactCommentAccess, commentId: string, value: unknown, threadId?: string) {
  if (value === undefined) return undefined;
  await write(actor, access, async tx => { if (threadId) await loadThread(tx, access, threadId); await sessionCommentQuota(tx, access); });
  return prepareArtifactCommentScreenshot(access.artifact.projectId, commentId, value);
}

export async function createArtifactCommentThread(actor: Actor, access: ArtifactCommentAccess, input: ArtifactCommentBodyInput & { anchor?: unknown }) {
  const parsed = artifactCommentAnchorSchema.safeParse(input.anchor);
  if (!parsed.success || (access.artifact.type === 'doc' && parsed.data.type !== 'text' && parsed.data.type !== 'none')) {
    throw new ArtifactCommentError(400, 'Invalid comment anchor', 'invalid_anchor');
  }
  const body = bodyText(input.body);
  const marks = marksFor(input.marks, parsed.data);
  const mentions = await resolveArtifactCommentMentions(access.artifact, body);
  const who = author(actor, access), commentId = randomUUID();
  const screenshot = await prepareImage(actor, access, commentId, input.screenshot_base64);
  let thread;
  try {
    thread = await write(actor, access, async (tx) => {
      await sessionCommentQuota(tx, access);
      const [thread] = await tx.insert(artifactCommentThreads).values({
        artifactId: access.artifact.artifactId, projectId: access.artifact.projectId, anchor: parsed.data,
        anchorVersion: parsed.data.version, createdByUserId: who.userId, createdBySessionId: who.sessionId,
      }).returning();
      const [comment] = await tx.insert(artifactComments).values({
        commentId, threadId: thread!.threadId, authorUserId: who.userId, authorSessionId: who.sessionId,
        body, mentions, marks, screenshotKey: screenshot?.objectKey ?? null, createdAt: sql`clock_timestamp()`,
      }).returning();
      if (screenshot) await attachArtifactCommentScreenshot(tx, screenshot);
      await recordArtifactEvent(tx, access.artifact, who, 'thread_opened', { thread_id: thread!.threadId, comment_id: comment!.commentId });
      await enqueueArtifactCommentRouting(tx, access.artifact, actor, access.sessionId, thread!.threadId, comment!.commentId, false);
      const [updated] = await tx.select().from(artifactCommentThreads).where(eq(artifactCommentThreads.threadId, thread!.threadId));
      Object.assign(thread!, updated!);
      return threadView(thread!, [comment!], access);
    }, !screenshot);
  } catch (error) { if (screenshot) await abandonArtifactCommentScreenshot(screenshot); throw error; }
  await dispatchArtifactCommentJobs(`artifact-comments:${thread.thread_id}:${thread.comments[0]!.comment_id}`);
  return (await hydrateThreads(access, [thread]))[0]!;
}

export async function replyArtifactCommentThread(actor: Actor, access: ArtifactCommentAccess, threadId: string, body: string | ArtifactCommentBodyInput) {
  const input = typeof body === 'string' ? { body } : body;
  const text = bodyText(input.body);
  const [rootThread] = await db.select().from(artifactCommentThreads).where(and(eq(artifactCommentThreads.threadId, threadId), eq(artifactCommentThreads.artifactId, access.artifact.artifactId)));
  if (!rootThread) throw new ArtifactCommentError(404, 'Comment thread not found', 'not_found');
  const marks = marksFor(input.marks, rootThread.anchor as ArtifactCommentAnchor);
  const mentions = await resolveArtifactCommentMentions(access.artifact, text);
  const who = author(actor, access), commentId = randomUUID();
  const screenshot = await prepareImage(actor, access, commentId, input.screenshot_base64, threadId);
  let comment;
  try {
    comment = await write(actor, access, async (tx) => {
      await loadThread(tx, access, threadId);
      await sessionCommentQuota(tx, access);
      const [comment] = await tx.insert(artifactComments).values({
        commentId, threadId, body: text, mentions, marks, screenshotKey: screenshot?.objectKey ?? null,
        authorUserId: who.userId, authorSessionId: who.sessionId, createdAt: sql`clock_timestamp()`,
      }).returning();
      if (screenshot) await attachArtifactCommentScreenshot(tx, screenshot);
      await tx.update(artifactCommentThreads).set({ updatedAt: sql`now()` }).where(eq(artifactCommentThreads.threadId, threadId));
      await recordArtifactEvent(tx, access.artifact, who, 'replied', { thread_id: threadId, comment_id: comment!.commentId });
      await enqueueArtifactCommentRouting(tx, access.artifact, actor, access.sessionId, threadId, comment!.commentId, true);
      return commentView(comment!, access);
    }, !screenshot);
  } catch (error) { if (screenshot) await abandonArtifactCommentScreenshot(screenshot); throw error; }
  await dispatchArtifactCommentJobs(`artifact-comments:${threadId}:${comment.comment_id}`);
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
    return threadView(thread, comments, access);
  });
  return (await hydrateThreads(access, [thread]))[0]!;
}

export async function changeArtifactComment(actor: Actor, access: ArtifactCommentAccess, threadId: string, commentId: string, body: string | null) {
  const text = body === null ? null : bodyText(body);
  const mentions = text === null ? [] : await resolveArtifactCommentMentions(access.artifact, text);
  let removedScreenshot: string | null = null;
  const comment = await write(actor, access, async (tx) => {
    await loadThread(tx, access, threadId);
    const [comment] = await tx.select().from(artifactComments)
      .where(and(eq(artifactComments.threadId, threadId), eq(artifactComments.commentId, commentId)));
    if (!comment) throw new ArtifactCommentError(404, 'Comment not found', 'not_found');
    if (comment.deletedAt) throw deleted();
    if (!own(actor, access, comment.authorUserId, comment.authorSessionId) && !(text === null && access.viewer.manageAny)) throw forbidden();
    if (text === null) removedScreenshot = comment.screenshotKey;
    const [updated] = await tx.update(artifactComments).set(text === null
      ? { body: '', mentions: [], marks: [], screenshotKey: null, deletedAt: sql`now()` }
      : { body: text, mentions, editedAt: sql`now()` })
      .where(eq(artifactComments.commentId, commentId)).returning();
    await tx.update(artifactCommentThreads).set({ updatedAt: sql`now()` }).where(eq(artifactCommentThreads.threadId, threadId));
    if (text === null) await recordArtifactEvent(tx, access.artifact, author(actor, access), 'comment_deleted', { thread_id: threadId, comment_id: commentId });
    return commentView(updated!, access);
  });
  if (removedScreenshot) await cleanupArtifactCommentScreenshotKeys([removedScreenshot]);
  return (await hydrateCommentAuthors(access.artifact, [comment]))[0]!;
}
