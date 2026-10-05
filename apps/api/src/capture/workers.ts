/**
 * Kortix Capture background work.
 *
 * Every replica: the job handlers (`capture.ingest`, `capture.process`,
 * `capture.episodes`, `capture.mine`, `capture.export`) run in the shared job
 * worker (shared/job-queue.ts).
 *
 * Leader only (startCaptureWorkers):
 *   - events reader: long-polls the SQS queue of the bucket's `*.manifest.json`
 *     ObjectCreated events (AWS), enqueueing one ingest per key;
 *   - index reader: for each active device, reads `status.json` (live status),
 *     `device.json` and every changed `index/<day>.jsonl`, enqueueing every
 *     complete item and retracting every item a `delete` line names (the person
 *     forgot it, or the device's retention removed it). Works on any S3 store,
 *     events or not; enqueue is idempotent, so the two readers never double-index;
 *   - maintenance: closes detected ranges after RANGE_GAP_MS of silence and
 *     queues their episodes (L1/L2), queues each account's nightly mining (L3), keeps monthly partitions 3 months ahead, applies
 *     remote retention, prunes expired sign-ins and finished jobs.
 */
import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { captureDeviceGrants, captureDevices, captureEpisodes, captureWorkspaces, rangeOutputs, timelineChunks, timelineRanges } from '@kortix/db';
import { and, eq, gt, gte, inArray, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import { config } from '../config';
import { logger } from '../lib/logger';
import { runWorkerTick } from '../shared/audit-scope';
import { db } from '../shared/db';
import { enqueueJob, enqueueJobs, pruneFinishedJobs, registerJobHandler } from '../shared/job-queue';
import { accountPrefix, deviceFields, foldIndex, jsonLines, PolicySchema, statusReportedAt, utcDay } from './format';
import { expireExports } from './exports';
import { RANGE_GAP_MS, ingestManifest } from './ingest';
import { readWorkspace } from './workspace';
import { processRange } from './processing';
import { CaptureBudgetExceeded } from './budget';
import { EPISODES_QUEUE, traceRange } from './episodes';
import { MINE_QUEUE, mineAccount, refreshWorkflows } from './mining';
import { captureRegion, captureStore, captureStoreConfigured, getCaptureObjectIfChanged } from './store';

export const INGEST_QUEUE = 'capture.ingest';
export const PROCESS_QUEUE = 'capture.process';

registerJobHandler(INGEST_QUEUE, async (job) => {
  const outcome = await ingestManifest(String(job.payload.key ?? job.jobKey));
  if (outcome.status === 'ignored') logger.warn('[capture] manifest ignored', { key: job.jobKey, reason: outcome.reason });
});
// A range pipeline makes many model calls; give it a long claim.
registerJobHandler(PROCESS_QUEUE, async (job) => processRange(String(job.payload.rangeId)), 30 * 60_000);

// Episodes: one model call per chunk of a range; 8 at once per replica. 6 attempts
// (10 s … 160 s backoff): the managed model answers 429 "at capacity" in bursts.
registerJobHandler(
  EPISODES_QUEUE,
  async (job) => {
    const rangeId = String(job.payload.rangeId);
    try {
      await traceRange(rangeId);
    } catch (error) {
      if (!(error instanceof CaptureBudgetExceeded)) throw error;
      await enqueueJob(EPISODES_QUEUE, `${job.jobKey}:next-day`, job.payload, { runAt: nextUtcDay() });
      return;
    }
    await enqueueMining(String(job.payload.accountId));
  },
  15 * 60_000,
  8,
);
registerJobHandler(
  MINE_QUEUE,
  async (job) => {
    try {
      await mineAccount(String(job.payload.accountId), undefined, Date.now(), { rename: job.payload.rename === true });
    } catch (error) {
      if (!(error instanceof CaptureBudgetExceeded)) throw error;
      await enqueueJob(MINE_QUEUE, `${job.jobKey}:next-day`, job.payload, { runAt: nextUtcDay() });
    }
  },
  15 * 60_000,
  1,
);

const nextUtcDay = () => new Date(Math.floor(Date.now() / 86_400_000 + 1) * 86_400_000 + 60_000);

/** Queue tracing of one closed detected range. A new end time is a new run. */
export function enqueueEpisodes(range: { rangeId: string; accountId: string; endAt: Date }, suffix = ''): Promise<boolean> {
  return enqueueJob(EPISODES_QUEUE, `${range.rangeId}:${range.endAt.getTime()}${suffix}`, { rangeId: range.rangeId, accountId: range.accountId }, { maxAttempts: 6 });
}

/** Queue mining of an account, debounced: one run per 10-minute slot, at its end. */
export function enqueueMining(accountId: string, slotMs = 10 * 60_000): Promise<boolean> {
  const slot = Math.floor(Date.now() / slotMs) + 1;
  return enqueueJob(MINE_QUEUE, `${accountId}:${slot}`, { accountId }, { runAt: new Date(slot * slotMs), maxAttempts: 6 });
}

/**
 * Run the pipelines now (an admin's "run" button): every closed or failed detected range of the
 * account is queued for episodes, then mining; or mining alone. Idempotent per call.
 */
export async function runIntelligence(accountId: string, opts: { miningOnly?: boolean } = {}): Promise<{ episodes_queued: number; mining_queued: boolean }> {
  const stamp = Date.now();
  let episodes = 0;
  if (!opts.miningOnly) {
    const ranges = await db
      .select({ rangeId: timelineRanges.rangeId, accountId: timelineRanges.accountId, endAt: timelineRanges.endAt })
      .from(timelineRanges)
      .where(and(eq(timelineRanges.accountId, accountId), eq(timelineRanges.source, 'detected'), inArray(timelineRanges.status, ['closed', 'failed'])));
    for (const range of ranges) if (await enqueueEpisodes(range, `:run-${stamp}`)) episodes++;
  }
  // With episodes queued, each finished range queues mining itself; else mine now.
  // A "run now" also names every unreviewed workflow again from its standard path.
  const mining = episodes ? false : await enqueueJob(MINE_QUEUE, `${accountId}:run-${stamp}`, { accountId, rename: true }, { maxAttempts: 6 });
  return { episodes_queued: episodes, mining_queued: mining || episodes > 0 };
}

export function enqueueManifest(key: string): Promise<boolean> {
  return enqueueJob(INGEST_QUEUE, key, { key });
}

/** Queue one processing run of a range. A new end time is a new run. */
export function enqueueRangeProcessing(range: { rangeId: string; endAt: Date }, suffix = ''): Promise<boolean> {
  return enqueueJob(PROCESS_QUEUE, `${range.rangeId}:${range.endAt.getTime()}${suffix}`, { rangeId: range.rangeId }, { maxAttempts: 3 });
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
  const files = await captureStore.list(`${folder}/index/`, { pageSize: 1000, maxPages: 2 });
  const next: Record<string, string> = {};
  for (const file of files) {
    const day = /\/index\/(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(file.key)?.[1];
    if (!day) continue;
    const mark = `${file.bytes}:${file.lastModified?.getTime() ?? 0}`;
    next[day] = mark;
    if (cursor[day] === mark) continue;
    const body = await captureStore.getText(file.key);
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
 * Retract the items a device deleted: their rows go, and so do the derived
 * outputs of every range of the device that overlaps them (a summary must not
 * outlive what it summarises). The range itself stays, `closed`, so a later
 * process run rebuilds it from what remains. The device already removed the
 * objects. Idempotent: a key with no row is a no-op.
 */
export async function forgetManifests(deviceId: string, keys: string[]): Promise<number> {
  if (keys.length === 0) return 0;
  const chunks = await db
    .select({ chunkId: timelineChunks.chunkId, accountId: timelineChunks.accountId, startAt: timelineChunks.startAt, endAt: timelineChunks.endAt })
    .from(timelineChunks)
    .where(and(eq(timelineChunks.deviceId, deviceId), inArray(timelineChunks.manifestKey, keys)));
  if (chunks.length === 0) return 0;
  const from = new Date(Math.min(...chunks.map((c) => c.startAt.getTime())));
  const to = new Date(Math.max(...chunks.map((c) => Math.max(c.startAt.getTime(), c.endAt.getTime()))));
  let forgotten: Array<{ rangeId: string; accountId: string; endAt: Date }> = [];
  let touched: string[] = [];
  let episodesGone = 0;
  await db.transaction(async (tx) => {
    await removeChunkRows(tx, chunks);
    const ranges = await tx
      .update(timelineRanges)
      .set({ status: 'closed', updatedAt: sql`now()` })
      .where(and(eq(timelineRanges.deviceId, deviceId), lte(timelineRanges.startAt, to), gte(timelineRanges.endAt, from), ne(timelineRanges.status, 'open')))
      .returning({ rangeId: timelineRanges.rangeId, accountId: timelineRanges.accountId, endAt: timelineRanges.endAt, source: timelineRanges.source });
    if (ranges.length) await tx.delete(rangeOutputs).where(inArray(rangeOutputs.rangeId, ranges.map((r) => r.rangeId)));
    // What was derived from the forgotten item goes with it: the device's detected episodes over its
    // span (their labels and steps quote it). A saved episode is the person's own title and stays.
    const gone = await tx
      .delete(captureEpisodes)
      .where(and(eq(captureEpisodes.deviceId, deviceId), eq(captureEpisodes.source, 'detected'), lte(captureEpisodes.startAt, to), gte(captureEpisodes.endAt, from)))
      .returning({ workflowId: captureEpisodes.workflowId });
    touched = [...new Set(gone.map((e) => e.workflowId).filter((id): id is string => !!id))];
    episodesGone = gone.length;
    forgotten = ranges.filter((r) => r.source === 'detected');
  });
  // Then what was built on those episodes: the workflows rebuild from the runs they still hold
  // (no model call), and every finished export of the account expires.
  await refreshWorkflows(touched);
  if (episodesGone) await expireExports(chunks[0]!.accountId);
  // The ranges trace again without the item (and mining follows).
  for (const range of forgotten) await enqueueEpisodes(range, `:forget-${Date.now()}`);
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

/** Close detected ranges silent for RANGE_GAP_MS and queue their episodes. */
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
    .returning({ rangeId: timelineRanges.rangeId, accountId: timelineRanges.accountId, endAt: timelineRanges.endAt });
  for (const range of closed) await enqueueEpisodes(range);
  return closed.length;
}

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
    await captureStore.remove(keys);
    await db.transaction(async (tx) => {
      await removeChunkRows(tx, old);
      await tx.delete(timelineRanges).where(and(eq(timelineRanges.accountId, accountId), lt(timelineRanges.endAt, cutoff)));
    });
    removed += old.length;
  }
  return removed;
}

let lastPartitionDay = '';
async function maintenance(): Promise<void> {
  const today = utcDay(Date.now());
  if (lastPartitionDay !== today) {
    await db.execute(sql`SELECT kortix.capture_timeline_ensure_partitions((now() AT TIME ZONE 'UTC')::date, 3)`);
    // Nightly mining of every account with episodes in the last day.
    const active = await db.execute<{ account_id: string }>(
      sql`SELECT DISTINCT account_id FROM kortix.capture_episodes WHERE updated_at > now() - interval '1 day'`,
    );
    for (const row of active) await enqueueJob(MINE_QUEUE, `${row.account_id}:nightly:${today}`, { accountId: row.account_id }, { maxAttempts: 3 });
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
