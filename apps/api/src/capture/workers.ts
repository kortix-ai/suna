/**
 * Kortix Capture background work.
 *
 * Every replica: the `capture.ingest` job handler runs in the shared job
 * worker (shared/job-queue.ts).
 *
 * Leader only (workers/capture-worker.ts runs these ticks):
 *   - events reader: long-polls the SQS queue of the bucket's `*.manifest.json`
 *     ObjectCreated events (AWS), enqueueing one ingest per key;
 *   - index reader: for each active device, reads `status.json` (live status),
 *     `device.json` and every changed `index/<day>.jsonl`, enqueueing every
 *     complete item and retracting every item a `delete` line names (the person
 *     forgot it, or the device's retention removed it). Works on any S3 store,
 *     events or not; enqueue is idempotent, so the two readers never double-index;
 *   - maintenance: keeps monthly partitions 3 months ahead, applies remote
 *     retention, prunes expired sign-ins and finished jobs.
 */
import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { captureDeviceGrants, captureDevices, captureWorkspaces, timelineChunks } from '@kortix/db';
import { and, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { config } from '../config';
import { logger } from '../lib/logger';
import { db } from '../shared/db';
import { enqueueJob, enqueueJobs, pruneFinishedJobs, registerJobHandler } from '../shared/job-queue';
import { accountPrefix, deviceFields, foldIndex, jsonLines, PolicySchema, statusReportedAt, utcDay } from './format';
import { ingestManifest } from './ingest';
import { reattributeDevice } from './reads';
import { readWorkspace } from './workspace';
import { captureRegion, captureStoreConfigured } from './store';
import { captureStoreForAccount } from './account-store';

export const INGEST_QUEUE = 'capture.ingest';

registerJobHandler(INGEST_QUEUE, async (job) => {
  const outcome = await ingestManifest(String(job.payload.key ?? job.jobKey));
  if (outcome.status === 'ignored') logger.warn('[capture] manifest ignored', { key: job.jobKey, reason: outcome.reason });
});

/** Moves the recordings a device made while unlinked to the person it was linked to (reads.ts `linkDevice`). */
export const LINK_QUEUE = 'capture.link';

registerJobHandler(LINK_QUEUE, async (job) => {
  const { accountId, deviceId, userId } = job.payload as { accountId: string; deviceId: string; userId: string };
  const [device] = await db.select({ userId: captureDevices.userId }).from(captureDevices).where(eq(captureDevices.deviceId, deviceId)).limit(1);
  // Relinked or unlinked since: the newer link owns the unlinked rows.
  if (device?.userId !== userId) return;
  if (!(await reattributeDevice(accountId, deviceId, userId))) await enqueueLink(accountId, deviceId, userId);
});

/** A new key each time: a finished job with the same key would swallow a later link. */
export function enqueueLink(accountId: string, deviceId: string, userId: string): Promise<boolean> {
  return enqueueJob(LINK_QUEUE, `${deviceId}:${userId}:${Date.now()}`, { accountId, deviceId, userId });
}

export function enqueueManifest(key: string): Promise<boolean> {
  return enqueueJob(INGEST_QUEUE, key, { key });
}

// ─── Index reader ────────────────────────────────────────────────────────────

/** Devices worth polling: not revoked, in an account with Capture on, seen in the last day. */
async function activeDevices() {
  const rows = await db
    .select({ device: captureDevices })
    .from(captureDevices)
    .innerJoin(captureWorkspaces, eq(captureWorkspaces.accountId, captureDevices.accountId))
    .where(
      and(
        isNull(captureDevices.revokedAt),
        eq(captureWorkspaces.enabled, true),
        or(
          gt(captureDevices.lastCredentialsAt, sql`now() - interval '1 day'`),
          gt(captureDevices.statusReportedAt, sql`now() - interval '1 day'`),
          gt(captureDevices.createdAt, sql`now() - interval '1 day'`),
        ),
      ),
    );
  return rows.map((row) => row.device);
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
export async function pollDevice(device: typeof captureDevices.$inferSelect): Promise<{ enqueued: number; forgotten: number }> {
  const folder = `${accountPrefix(device.accountId)}/${device.deviceId}`;
  const patch: Partial<typeof captureDevices.$inferInsert> = {};
  const store = await captureStoreForAccount(device.accountId);

  const status = await store.getBytes(`${folder}/status.json`, { maxBytes: 1024 * 1024 });
  if (status) {
    const doc = decodeJson(status);
    const reported = statusReportedAt(doc);
    if (doc && reported) {
      patch.status = doc;
      patch.statusReportedAt = new Date(reported);
    }
  }
  const described = await store.getBytes(`${folder}/device.json`, { maxBytes: 1024 * 1024 });
  if (described) {
    const doc = decodeJson(described);
    if (doc) Object.assign(patch, { deviceInfo: doc, ...deviceFields(doc) });
  }

  // Every index day file that changed since the last poll: a device that was
  // offline uploads its backlog into the day files of when it recorded, not today.
  // Cursor (index_etag): {"<day>": "<bytes>:<last modified ms>"} of the files read.
  let enqueued = 0;
  let forgotten = 0;
  let cursor: Record<string, string> = {};
  try {
    cursor = JSON.parse(device.indexEtag ?? '{}') ?? {};
  } catch {
    cursor = {};
  }
  const files = await store.list(`${folder}/index/`, { pageSize: 1000, maxPages: 2 });
  const next: Record<string, string> = {};
  for (const file of files) {
    const day = /\/index\/(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(file.key)?.[1];
    if (!day) continue;
    const mark = `${file.bytes}:${file.lastModified?.getTime() ?? 0}`;
    next[day] = mark;
    if (cursor[day] === mark) continue;
    const body = await store.getText(file.key);
    if (body === null) continue;
    const { live, deleted } = foldIndex(accountPrefix(device.accountId), device.deviceId, body);
    enqueued += await enqueueJobs(INGEST_QUEUE, live.map((key) => ({ key, payload: { key } })));
    forgotten += await forgetManifests(device.deviceId, deleted);
  }
  const days = Object.keys(next).sort();
  if (JSON.stringify(next) !== JSON.stringify(cursor)) {
    Object.assign(patch, { indexDay: days[days.length - 1] ?? null, indexEtag: JSON.stringify(next), indexLines: days.length });
  }

  if (Object.keys(patch).length) {
    await db.update(captureDevices).set({ ...patch, updatedAt: sql`now()` }).where(eq(captureDevices.deviceId, device.deviceId));
  }
  return { enqueued, forgotten };
}

/**
 * Retract the items a device deleted: their chunk, frame, action and audio
 * rows go. The device already removed the objects. Idempotent: a key with no
 * row is a no-op.
 */
export async function forgetManifests(deviceId: string, keys: string[]): Promise<number> {
  if (keys.length === 0) return 0;
  const chunks = await db
    .select({ chunkId: timelineChunks.chunkId, startAt: timelineChunks.startAt, endAt: timelineChunks.endAt })
    .from(timelineChunks)
    .where(and(eq(timelineChunks.deviceId, deviceId), inArray(timelineChunks.manifestKey, keys)));
  if (chunks.length === 0) return 0;
  await db.transaction((tx) => removeChunkRows(tx, chunks));
  logger.info('[capture] forgot items', { deviceId, items: chunks.length });
  return chunks.length;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Delete chunks and their frame, action and audio rows. */
async function removeChunkRows(tx: Tx, chunks: Array<{ chunkId: string; startAt: Date; endAt: Date }>): Promise<void> {
  const ids = chunks.map((chunk) => chunk.chunkId);
  // Bounds on `ts` let Postgres prune the monthly partitions; a day of slack covers device clock skew.
  const floor = new Date(Math.min(...chunks.map((chunk) => chunk.startAt.getTime())) - 86_400_000);
  const ceil = new Date(Math.max(...chunks.map((chunk) => Math.max(chunk.startAt.getTime(), chunk.endAt.getTime()))) + 86_400_000);
  for (const table of ['timeline_frames', 'timeline_actions', 'timeline_audio']) {
    await tx.execute(
      sql`DELETE FROM ${sql.identifier('kortix')}.${sql.identifier(table)} WHERE chunk_id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}) AND ts >= ${floor.toISOString()}::timestamptz AND ts < ${ceil.toISOString()}::timestamptz`,
    );
  }
  await tx.delete(timelineChunks).where(inArray(timelineChunks.chunkId, ids));
}

export async function pollAllDevices(): Promise<void> {
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

export async function receiveEvents(): Promise<void> {
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

/** Delete indexed items (rows and objects) older than each account's `remote_days`. Bounded per tick. */
export async function applyRetention(limitPerAccount = 200): Promise<number> {
  if (!captureStoreConfigured()) return 0;
  const accountIds = await db.selectDistinct({ accountId: timelineChunks.accountId }).from(timelineChunks);
  let removed = 0;
  for (const { accountId } of accountIds) {
    const { policy } = await readWorkspace(accountId);
    const days = PolicySchema.parse(policy).retention.remote_days;
    if (!days) continue;
    const cutoff = new Date(Date.now() - days * 86_400_000);
    const old = await db
      .select({ chunkId: timelineChunks.chunkId, manifestKey: timelineChunks.manifestKey, manifest: timelineChunks.manifest, startAt: timelineChunks.startAt, endAt: timelineChunks.endAt })
      .from(timelineChunks)
      .where(and(eq(timelineChunks.accountId, accountId), lt(timelineChunks.endAt, cutoff)))
      .limit(limitPerAccount);
    if (old.length === 0) continue;
    const prefix = accountPrefix(accountId);
    const keys = old.flatMap((chunk) => [
      chunk.manifestKey,
      ...Object.values((chunk.manifest.objects ?? {}) as Record<string, { key: string }>).map((o) =>
        o.key.startsWith(`${prefix}/`) ? o.key : `${prefix}/${o.key}`,
      ),
    ]);
    // Objects first: a row without its object is harmless; an object without a row is invisible forever.
    await (await captureStoreForAccount(accountId)).remove(keys);
    await db.transaction((tx) => removeChunkRows(tx, old));
    removed += old.length;
  }
  return removed;
}

let lastPartitionDay = '';
export async function captureMaintenance(): Promise<void> {
  const today = utcDay(Date.now());
  if (lastPartitionDay !== today) {
    await db.execute(sql`SELECT kortix.capture_timeline_ensure_partitions((now() AT TIME ZONE 'UTC')::date, 3)`);
    lastPartitionDay = today;
  }
  await applyRetention();
  await db.delete(captureDeviceGrants).where(lt(captureDeviceGrants.expiresAt, sql`now() - interval '1 day'`));
  await pruneFinishedJobs(7);
}
