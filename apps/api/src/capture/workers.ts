/**
 * Kortix Capture background work.
 *
 * Every replica: the job handlers (`capture.ingest`, `capture.process`) run in
 * the shared job worker (shared/job-queue.ts).
 *
 * Leader only (startCaptureWorkers):
 *   - events reader: long-polls the SQS queue of the bucket's `*.manifest.json`
 *     ObjectCreated events (AWS), enqueueing one ingest per key;
 *   - index reader: for each active device, reads `status.json` (live status),
 *     `device.json` and today's `index/<day>.jsonl`, enqueueing every complete
 *     item. Works on any S3 store, events or not; enqueue is idempotent, so the
 *     two readers never double-index;
 *   - maintenance: closes detected ranges after RANGE_GAP_MS of silence and
 *     queues their processing, keeps monthly partitions 3 months ahead, applies
 *     remote retention, prunes expired sign-ins and finished jobs.
 */
import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { captureDeviceGrants, captureDevices, projects, timelineChunks, timelineRanges } from '@kortix/db';
import { and, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { config } from '../config';
import { resolveFeatureFlag } from '../feature-flags/registry';
import { logger } from '../lib/logger';
import { runWorkerTick } from '../shared/audit-scope';
import { db } from '../shared/db';
import { enqueueJob, enqueueJobs, pruneFinishedJobs, registerJobHandler } from '../shared/job-queue';
import { deviceFields, jsonLines, manifestKeysFromIndex, PolicySchema, projectPrefix, statusReportedAt, utcDay } from './format';
import { RANGE_GAP_MS, ingestManifest } from './ingest';
import { readProjectPolicy } from './policy';
import { processRange } from './processing';
import { captureRegion, captureStore, captureStoreConfigured, getCaptureObjectIfChanged } from './store';

export const INGEST_QUEUE = 'capture.ingest';
export const PROCESS_QUEUE = 'capture.process';

registerJobHandler(INGEST_QUEUE, async (job) => {
  const outcome = await ingestManifest(String(job.payload.key ?? job.jobKey));
  if (outcome.status === 'ignored') logger.warn('[capture] manifest ignored', { key: job.jobKey, reason: outcome.reason });
});
// A range pipeline makes many model calls; give it a long claim.
registerJobHandler(PROCESS_QUEUE, async (job) => processRange(String(job.payload.rangeId)), 30 * 60_000);

export function enqueueManifest(key: string): Promise<boolean> {
  return enqueueJob(INGEST_QUEUE, key, { key });
}

/** Queue one processing run of a range. A new end time is a new run. */
export function enqueueRangeProcessing(range: { rangeId: string; endAt: Date }, suffix = ''): Promise<boolean> {
  return enqueueJob(PROCESS_QUEUE, `${range.rangeId}:${range.endAt.getTime()}${suffix}`, { rangeId: range.rangeId }, { maxAttempts: 3 });
}

// ─── Index reader ────────────────────────────────────────────────────────────

/** Devices worth polling: not revoked, in a capture project, seen in the last day. */
async function activeDevices() {
  const rows = await db
    .select({ device: captureDevices, metadata: projects.metadata })
    .from(captureDevices)
    .innerJoin(projects, eq(projects.projectId, captureDevices.projectId))
    .where(
      and(
        isNull(captureDevices.revokedAt),
        or(
          gt(captureDevices.lastCredentialsAt, sql`now() - interval '1 day'`),
          gt(captureDevices.statusReportedAt, sql`now() - interval '1 day'`),
          gt(captureDevices.createdAt, sql`now() - interval '1 day'`),
        ),
      ),
    );
  return rows.filter((row) => resolveFeatureFlag(row.metadata, 'capture')).map((row) => row.device);
}

const decodeJson = (bytes: Uint8Array): Record<string, unknown> | null => {
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
};

/** Read one device's status, description and index. Exported for the flow-facing sync route and tests. */
export async function pollDevice(device: typeof captureDevices.$inferSelect): Promise<{ enqueued: number }> {
  const folder = `${projectPrefix(device.accountId, device.projectId)}/${device.deviceId}`;
  const patch: Partial<typeof captureDevices.$inferInsert> = {};

  const status = await getCaptureObjectIfChanged(`${folder}/status.json`, null);
  if (status.status === 'ok') {
    const doc = decodeJson(status.body);
    const reported = statusReportedAt(doc);
    if (doc && reported) {
      patch.status = doc;
      patch.statusReportedAt = new Date(reported);
    }
  }
  const described = await getCaptureObjectIfChanged(`${folder}/device.json`, null);
  if (described.status === 'ok') {
    const doc = decodeJson(described.body);
    if (doc) Object.assign(patch, { deviceInfo: doc, ...deviceFields(doc) });
  }

  // Today's index. On the first poll of a UTC day (or of a new device), yesterday's
  // too, once: it catches late lines and items that started before midnight.
  let enqueued = 0;
  const today = utcDay(Date.now());
  const days = device.indexDay === today ? [today] : [utcDay(Date.now() - 86_400_000), today];
  for (const day of days) {
    const etag = day === device.indexDay ? device.indexEtag : null;
    const index = await getCaptureObjectIfChanged(`${folder}/index/${day}.jsonl`, day === today ? etag : null);
    if (index.status !== 'ok') continue;
    const keys = manifestKeysFromIndex(
      projectPrefix(device.accountId, device.projectId),
      device.deviceId,
      new TextDecoder().decode(index.body),
    );
    enqueued += await enqueueJobs(INGEST_QUEUE, keys.map((key) => ({ key, payload: { key } })));
    if (day === today) Object.assign(patch, { indexDay: today, indexEtag: index.etag, indexLines: keys.length });
  }
  if (!patch.indexDay && device.indexDay !== today) Object.assign(patch, { indexDay: today, indexEtag: null, indexLines: 0 });

  if (Object.keys(patch).length) {
    await db.update(captureDevices).set({ ...patch, updatedAt: sql`now()` }).where(eq(captureDevices.deviceId, device.deviceId));
  }
  return { enqueued };
}

async function pollAllDevices(): Promise<void> {
  if (!captureStoreConfigured()) return;
  for (const device of await activeDevices()) {
    try {
      await pollDevice(device);
    } catch (error) {
      logger.warn('[capture] device poll failed', { deviceId: device.deviceId, error: String(error) });
    }
  }
}

// ─── Events reader (SQS) ─────────────────────────────────────────────────────

let sqs: SQSClient | null = null;

/** The manifest keys in one S3 event notification body. */
export function manifestKeysFromEvent(body: string): string[] {
  const doc = jsonLines(body)[0];
  const records = Array.isArray(doc?.Records) ? (doc.Records as Array<Record<string, any>>) : [];
  return records
    .map((record) => record?.s3?.object?.key)
    .filter((key): key is string => typeof key === 'string')
    .map((key) => decodeURIComponent(key.replace(/\+/g, ' ')))
    .filter((key) => key.endsWith('.manifest.json'));
}

async function receiveEvents(): Promise<void> {
  const queueUrl = config.KORTIX_CAPTURE_SQS_QUEUE_URL!;
  sqs ??= new SQSClient({ region: captureRegion() });
  const out = await sqs.send(
    new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 20, VisibilityTimeout: 60 }),
  );
  for (const message of out.Messages ?? []) {
    for (const key of manifestKeysFromEvent(message.Body ?? '')) await enqueueManifest(key);
    // Deleted only after every key is durably queued; a crash before redelivers it.
    await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle! }));
  }
}

// ─── Maintenance ─────────────────────────────────────────────────────────────

/** Close detected ranges silent for RANGE_GAP_MS and queue their processing. */
export async function closeQuietRanges(): Promise<number> {
  const closed = await db
    .update(timelineRanges)
    .set({ status: 'closed', updatedAt: sql`now()` })
    .where(
      and(
        eq(timelineRanges.status, 'open'),
        eq(timelineRanges.source, 'detected'),
        lt(timelineRanges.endAt, new Date(Date.now() - RANGE_GAP_MS)),
      ),
    )
    .returning({ rangeId: timelineRanges.rangeId, endAt: timelineRanges.endAt });
  for (const range of closed) await enqueueRangeProcessing(range);
  return closed.length;
}

/** Delete indexed items (rows and objects) older than each project's `remote_days`. Bounded per tick. */
export async function applyRetention(limitPerProject = 200): Promise<number> {
  if (!captureStoreConfigured()) return 0;
  const projectIds = await db.selectDistinct({ projectId: timelineChunks.projectId }).from(timelineChunks);
  let removed = 0;
  for (const { projectId } of projectIds) {
    const { policy } = await readProjectPolicy(projectId);
    const days = PolicySchema.parse(policy).retention.remote_days;
    if (!days) continue;
    const cutoff = new Date(Date.now() - days * 86_400_000);
    const old = await db
      .select({ chunkId: timelineChunks.chunkId, manifestKey: timelineChunks.manifestKey, manifest: timelineChunks.manifest, startAt: timelineChunks.startAt })
      .from(timelineChunks)
      .where(and(eq(timelineChunks.projectId, projectId), lt(timelineChunks.endAt, cutoff)))
      .limit(limitPerProject);
    if (old.length === 0) continue;
    const prefix = old[0]!.manifestKey.split('/').slice(0, 4).join('/');
    const keys = old.flatMap((chunk) => [
      chunk.manifestKey,
      ...Object.values((chunk.manifest.objects ?? {}) as Record<string, { key: string }>).map((o) =>
        o.key.startsWith(`${prefix}/`) ? o.key : `${prefix}/${o.key}`,
      ),
    ]);
    // Objects first: a row without its object is harmless; an object without a row is invisible forever.
    await captureStore.remove(keys);
    const ids = old.map((chunk) => chunk.chunkId);
    const floor = new Date(Math.min(...old.map((chunk) => chunk.startAt.getTime())) - 86_400_000);
    await db.transaction(async (tx) => {
      for (const table of ['timeline_frames', 'timeline_actions', 'timeline_audio']) {
        await tx.execute(
          sql`DELETE FROM ${sql.identifier('kortix')}.${sql.identifier(table)} WHERE chunk_id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}) AND ts >= ${floor} AND ts < ${cutoff}`,
        );
      }
      await tx.delete(timelineChunks).where(inArray(timelineChunks.chunkId, ids));
      await tx.delete(timelineRanges).where(and(eq(timelineRanges.projectId, projectId), lt(timelineRanges.endAt, cutoff)));
    });
    removed += ids.length;
  }
  return removed;
}

let lastPartitionDay = '';
async function maintenance(): Promise<void> {
  const today = utcDay(Date.now());
  if (lastPartitionDay !== today) {
    await db.execute(sql`SELECT kortix.capture_timeline_ensure_partitions((now() AT TIME ZONE 'UTC')::date, 3)`);
    lastPartitionDay = today;
  }
  await closeQuietRanges();
  await applyRetention();
  await db.delete(captureDeviceGrants).where(lt(captureDeviceGrants.expiresAt, sql`now() - interval '1 day'`));
  await pruneFinishedJobs(7);
}

// ─── Loops ───────────────────────────────────────────────────────────────────

const loops: Array<{ stop: () => void }> = [];

function loop(name: string, everyMs: () => number, tick: () => Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const run = async () => {
    let delay = everyMs();
    try {
      await tick();
    } catch (error) {
      // A failing tick (no permission, store down) must not spin: wait at least 30 s.
      delay = Math.max(delay, 30_000);
      logger.error(`[capture] ${name} tick failed`, { error: String(error) });
    }
    if (!stopped) timer = setTimeout(run, delay);
  };
  timer = setTimeout(run, 1_000);
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

export function startCaptureWorkers(): void {
  if (loops.length) return;
  loops.push(
    loop('capture-index-reader', () => config.KORTIX_CAPTURE_INDEX_POLL_SECONDS * 1000, () =>
      runWorkerTick('capture-index-reader', pollAllDevices),
    ),
  );
  loops.push(loop('capture-maintenance', () => 5 * 60_000, () => runWorkerTick('capture-maintenance', maintenance)));
  if ((config.KORTIX_CAPTURE_SQS_QUEUE_URL ?? '').trim()) {
    // Long polling waits up to 20 s inside the call; the loop re-arms at once.
    loops.push(loop('capture-events-reader', () => 0, () => runWorkerTick('capture-events-reader', receiveEvents)));
  }
}

export function stopCaptureWorkers(): void {
  for (const l of loops.splice(0)) l.stop();
}
