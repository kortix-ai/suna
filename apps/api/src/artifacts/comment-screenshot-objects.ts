import { randomUUID } from 'node:crypto';
import { artifactComments, artifactCommentScreenshotObjects as objects } from '@kortix/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { logger } from '../lib/logger';
import { artifactScreenshotStore, screenshotKeyMatches, screenshotObjectKey } from './comment-screenshot-storage';
import { ArtifactCommentScreenshotError, decodeArtifactCommentScreenshot } from './comment-screenshot-validation';

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Store = Awaited<ReturnType<typeof artifactScreenshotStore>>;
type Receipt = typeof objects.$inferSelect;
export interface PreparedArtifactScreenshot { objectKey: string; projectId: string; commentId: string }
const unavailable = () => new ArtifactCommentScreenshotError(503, 'screenshot_storage_unavailable', 'Screenshot storage is unavailable. Retry this request.');

export async function prepareArtifactCommentScreenshot(projectId: string, commentId: string, value: unknown, store?: Store): Promise<PreparedArtifactScreenshot> {
  const image = await decodeArtifactCommentScreenshot(value);
  const objectKey = screenshotObjectKey(projectId, commentId, image.extension);
  await db.insert(objects).values({ objectKey, projectId, sizeBytes: image.bytes.byteLength });
  try { await (store ?? await artifactScreenshotStore()).put(objectKey, image); } catch { throw unavailable(); }
  const confirmed = await db.update(objects).set({ uploadConfirmed: true })
    .where(and(eq(objects.objectKey, objectKey), eq(objects.state, 'uploading'), isNull(objects.leaseId))).returning({ key: objects.objectKey });
  if (!confirmed.length) throw unavailable();
  return { objectKey, projectId, commentId };
}

export async function attachArtifactCommentScreenshot(tx: Transaction, prepared: PreparedArtifactScreenshot): Promise<void> {
  const attached = await tx.update(objects).set({ state: 'attached', uploadConfirmed: true, commentId: prepared.commentId })
    .where(and(eq(objects.objectKey, prepared.objectKey), eq(objects.projectId, prepared.projectId), eq(objects.state, 'uploading'), isNull(objects.commentId), isNull(objects.leaseId)))
    .returning({ key: objects.objectKey });
  if (!attached.length) throw unavailable();
}

export async function abandonArtifactCommentScreenshot(prepared: PreparedArtifactScreenshot, store?: Store): Promise<void> {
  try {
    const abandoned = await db.update(objects).set({ state: 'deleting', nextAttemptAt: sql`now()` })
      .where(and(eq(objects.objectKey, prepared.objectKey), eq(objects.state, 'uploading'), isNull(objects.commentId)))
      .returning({ key: objects.objectKey });
    if (abandoned.length) await cleanupArtifactCommentScreenshots({ keys: [prepared.objectKey], store });
  } catch {
    logger.warn('[artifact-screenshots] upload receipt retained for reconciliation');
  }
}

async function claim(options: { keys?: readonly string[]; projectId?: string; limit: number }): Promise<Receipt[]> {
  if (options.keys && !options.keys.length) return [];
  const filters = [sql`${objects.state} <> 'attached'`, sql`${objects.nextAttemptAt} <= now()`, sql`(${objects.lockedUntil} is null or ${objects.lockedUntil} < now())`];
  if (options.keys) filters.push(inArray(objects.objectKey, [...options.keys]));
  if (options.projectId) filters.push(eq(objects.projectId, options.projectId));
  const due = sql`(select object_key from kortix.artifact_comment_screenshot_objects where ${and(...filters)} order by next_attempt_at limit ${options.limit} for update skip locked)`;
  return db.update(objects).set({ state: 'deleting', leaseId: randomUUID(), lockedUntil: sql`now() + interval '1 minute'`, attempts: sql`least(${objects.attempts}::bigint + 1, 2147483647)::integer` })
    .where(inArray(objects.objectKey, due)).returning();
}

export async function cleanupArtifactCommentScreenshots(options: { keys?: readonly string[]; projectId?: string; limit?: number; store?: Store } = {}) {
  const rows = await claim({ ...options, limit: Math.max(1, Math.min(options.limit ?? 8, 32)) });
  let removed = 0, deferred = 0;
  await Promise.all(rows.map(async (row) => {
    const own = and(eq(objects.objectKey, row.objectKey), eq(objects.leaseId, row.leaseId!), eq(objects.state, 'deleting'));
    try {
      if (row.commentId) {
        const [comment] = await db.select({ key: artifactComments.screenshotKey, deleted: artifactComments.deletedAt }).from(artifactComments).where(eq(artifactComments.commentId, row.commentId));
        if (comment?.key === row.objectKey && !comment.deleted) {
          await db.update(objects).set({ state: 'attached', leaseId: null, lockedUntil: null }).where(own);
          deferred++;
          return;
        }
      }
      if (!screenshotKeyMatches(row.objectKey, row.projectId)) throw unavailable();
      await (options.store ?? await artifactScreenshotStore()).remove(row.objectKey);
      if (row.uploadConfirmed) await db.delete(objects).where(own);
      else await db.update(objects).set({ leaseId: null, lockedUntil: null, nextAttemptAt: sql`now() + interval '1 day'` }).where(own);
      removed++;
    } catch {
      const delay = Math.min(10 * 2 ** Math.min(row.attempts - 1, 12), 3600);
      await db.update(objects).set({ leaseId: null, lockedUntil: null, nextAttemptAt: sql`now() + make_interval(secs => ${delay})` }).where(own);
      deferred++;
      logger.warn('[artifact-screenshots] deletion deferred; durable object receipt retained');
    }
  }));
  return { claimed: rows.length, removed, deferred };
}

export async function cleanupArtifactCommentScreenshotKeys(keys: readonly string[], store?: Store): Promise<void> {
  if (!keys.length) return;
  try {
    for (;;) {
      const result = await cleanupArtifactCommentScreenshots({ keys, store });
      if (!result.claimed) break;
    }
  } catch {
    logger.warn('[artifact-screenshots] scoped deletion retained for background retry');
  }
}

export async function releaseArtifactCommentScreenshotsForProject(projectId: string): Promise<void> {
  await db.update(objects).set({ state: 'deleting', nextAttemptAt: sql`now()` }).where(eq(objects.projectId, projectId));
  await db.update(artifactComments).set({ screenshotKey: null }).where(inArray(artifactComments.commentId,
    sql`(select c.comment_id from kortix.artifact_comments c join kortix.artifact_comment_threads t using(thread_id) where t.project_id=${projectId} and c.screenshot_key is not null)`));
  const rows = await db.select({ key: objects.objectKey }).from(objects).where(and(eq(objects.projectId, projectId), eq(objects.state, 'deleting')));
  await cleanupArtifactCommentScreenshotKeys(rows.map(row => row.key));
}

let running = false;
let nextSweepAt = 0;
export function kickArtifactCommentScreenshotCleanup(enabled: boolean): void {
  if (!enabled || running || Date.now() < nextSweepAt) return;
  running = true;
  nextSweepAt = Date.now() + 60_000;
  void cleanupArtifactCommentScreenshots().catch(() => {
    logger.warn('[artifact-screenshots] cleanup sweep deferred');
  }).finally(() => { running = false; });
}
