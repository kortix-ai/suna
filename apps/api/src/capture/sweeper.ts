// Hourly retention for Kortix Capture: chunks older than the account's
// `retention_days` (default 30 without a settings row) and uploads that never
// committed within a day. Objects go first, then rows; a failed batch leaves
// its rows for the next tick. Safe across replicas: a row a peer deleted is
// not matched. Recursive setTimeout keeps ticks serial per process.
import { captureChunks, captureAccountSettings } from '@kortix/db';
import { eq, or, and, lt, sql } from 'drizzle-orm';
import type { ObjectStore } from '../object-store/s3';
import { runWorkerTick } from '../shared/audit-scope';
import { db } from '../shared/db';
import { deleteChunks } from './chunks';
import { captureStore } from './store';

const TICK_MS = 60 * 60_000;
const BATCH = 500;
const MAX_BATCHES = 20;
let timer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;

export async function runCaptureRetentionOnce(store: ObjectStore = captureStore): Promise<number> {
  if (!store.configured) return 0;
  let deleted = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const rows = await db
      .select({ id: captureChunks.id, videoKey: captureChunks.videoKey })
      .from(captureChunks)
      .leftJoin(captureAccountSettings, eq(captureAccountSettings.accountId, captureChunks.accountId))
      .where(
        or(
          lt(
            captureChunks.startedAt,
            sql`now() - make_interval(days => coalesce(${captureAccountSettings.retentionDays}, 30))`,
          ),
          and(eq(captureChunks.status, 'pending'), lt(captureChunks.createdAt, sql`now() - interval '1 day'`)),
        ),
      )
      .limit(BATCH);
    deleted += await deleteChunks(rows, store);
    if (rows.length < BATCH) break;
  }
  return deleted;
}

async function tickAndRearm(): Promise<void> {
  try {
    const deleted = await runWorkerTick('capture-retention', runCaptureRetentionOnce);
    if (deleted) console.info('[capture retention] deleted chunks', deleted);
  } catch (err) {
    console.error('[capture retention] tick failed', err);
  }
  if (!stopped) timer = setTimeout(tickAndRearm, TICK_MS);
}

export function startCaptureSweeper(): void {
  if (timer) return;
  stopped = false;
  void tickAndRearm();
}

export function stopCaptureSweeper(): void {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
}
