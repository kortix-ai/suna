/**
 * Bulk export of Capture Intelligence (L1 episodes, L2 steps, L3 workflows) as
 * JSONL, one record per line with a `type`, written to the capture store at
 * `orgs/<account_id>/exports/<export_id>.jsonl` and downloaded by signed URL.
 */
import { captureEpisodeSteps, captureEpisodes, captureExports, captureWorkflows } from '@kortix/db';
import { and, asc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { enqueueJob, registerJobHandler } from '../shared/job-queue';
import { accountPrefix } from './format';
import { episodeView, workflowSummary } from './intelligence';
import { captureStore, putCaptureObject } from './store';

export const EXPORT_QUEUE = 'capture.export';
export const EXPORT_URL_TTL_SECONDS = 3600;

export function exportKey(accountId: string, exportId: string, format: string): string {
  return `${accountPrefix(accountId)}/exports/${exportId}.${format}`;
}

export function enqueueExport(exportId: string): Promise<boolean> {
  return enqueueJob(EXPORT_QUEUE, exportId, { exportId }, { maxAttempts: 3 });
}

/** Build the JSONL body. ponytail: built in memory; stream to multipart when one account's L1–L3 outgrows ~100 MB. */
export async function exportJsonl(accountId: string, params: { from?: string; to?: string; include?: string[] }) {
  const include = new Set(params.include?.length ? params.include : ['episodes', 'steps', 'workflows']);
  const span = and(
    eq(captureEpisodes.accountId, accountId),
    params.from ? gte(captureEpisodes.endAt, new Date(params.from)) : undefined,
    params.to ? lt(captureEpisodes.startAt, new Date(params.to)) : undefined,
  );
  const lines: string[] = [];
  if (include.has('workflows')) {
    const workflows = await db.select().from(captureWorkflows).where(eq(captureWorkflows.accountId, accountId));
    for (const w of workflows) lines.push(JSON.stringify({ type: 'workflow', ...workflowSummary(w), outcome: w.outcome, steps: w.steps, variants: w.variants }));
  }
  if (include.has('episodes')) {
    const episodes = await db.select().from(captureEpisodes).where(span).orderBy(asc(captureEpisodes.startAt));
    for (const e of episodes) lines.push(JSON.stringify({ type: 'episode', ...episodeView(e) }));
  }
  if (include.has('steps')) {
    const steps = await db
      .select({ step: captureEpisodeSteps })
      .from(captureEpisodeSteps)
      .innerJoin(captureEpisodes, eq(captureEpisodes.episodeId, captureEpisodeSteps.episodeId))
      .where(span)
      .orderBy(asc(captureEpisodeSteps.episodeId), asc(captureEpisodeSteps.index));
    for (const { step: s } of steps) {
      lines.push(JSON.stringify({ type: 'step', episode_id: s.episodeId, index: s.index, ts: s.ts.toISOString(), verb: s.verb, app: s.app, object: s.object, params: s.params, variables: s.variables }));
    }
  }
  return { body: lines.length ? `${lines.join('\n')}\n` : '', rows: lines.length };
}

registerJobHandler(EXPORT_QUEUE, async (job) => {
  const exportId = String(job.payload.exportId);
  const [row] = await db.select().from(captureExports).where(eq(captureExports.exportId, exportId)).limit(1);
  if (!row || row.status === 'done') return;
  await db.update(captureExports).set({ status: 'running', updatedAt: sql`now()` }).where(eq(captureExports.exportId, exportId));
  try {
    const { body, rows } = await exportJsonl(row.accountId, row.params as { from?: string; to?: string; include?: string[] });
    const key = exportKey(row.accountId, exportId, 'jsonl');
    await putCaptureObject(key, body, 'application/x-ndjson');
    await db
      .update(captureExports)
      .set({ status: 'done', objectKey: key, rows, bytes: new TextEncoder().encode(body).byteLength, updatedAt: sql`now()` })
      .where(eq(captureExports.exportId, exportId));
  } catch (error) {
    await db.update(captureExports).set({ status: 'failed', error: String(error).slice(0, 2000), updatedAt: sql`now()` }).where(eq(captureExports.exportId, exportId));
    throw error;
  }
});

/**
 * After a forget, no export may still hold what was forgotten: every finished export of the
 * account loses its object and reads as failed ("expired"). A new export reads the data as it is now.
 */
export async function expireExports(accountId: string): Promise<number> {
  const done = await db
    .select({ exportId: captureExports.exportId, objectKey: captureExports.objectKey })
    .from(captureExports)
    .where(and(eq(captureExports.accountId, accountId), eq(captureExports.status, 'done')));
  const keys = done.map((e) => e.objectKey).filter((k): k is string => !!k);
  if (keys.length) await captureStore.remove(keys);
  if (done.length) {
    await db
      .update(captureExports)
      .set({ status: 'failed', objectKey: null, error: 'expired: an item in its span was forgotten; export again', updatedAt: sql`now()` })
      .where(inArray(captureExports.exportId, done.map((e) => e.exportId)));
  }
  return done.length;
}

export async function exportDownload(objectKey: string | null) {
  if (!objectKey) return null;
  const signed = await captureStore.presignDownload(objectKey, EXPORT_URL_TTL_SECONDS);
  return { url: signed.url, expires_at: signed.expiresAt.toISOString() };
}
