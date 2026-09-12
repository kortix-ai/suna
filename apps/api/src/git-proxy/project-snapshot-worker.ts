/**
 * Leader-only worker that turns queued `project_snapshot_archives` rows into
 * published archives. Same shape as the other singleton workers
 * (`shared/audit-webhooks.ts`): a recursive `setTimeout` tick so a slow build
 * can never overlap the next tick in this process, `SKIP LOCKED` claims so a
 * leadership flap can never double-build a row, and every outcome settled on
 * the row itself so failure stays visible and retryable.
 *
 * Runs whenever the bucket is configured — independent of the consumption
 * mode — so archives can be prepared before `prefer-s3` is switched on.
 */
import {
  claimProjectSnapshots,
  newProjectSnapshotWorkerId,
  processProjectSnapshot,
  type ProcessedProjectSnapshot,
} from './project-snapshot';
import { projectSnapshotStorageConfigured } from './project-snapshot-store';

const CLAIM_BATCH = 2;
const IDLE_MS = 5_000;
const ERROR_MS = 15_000;
const WORKER_ID = newProjectSnapshotWorkerId();

let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let stopped = true;
let activeTick: Promise<void> | null = null;

function logOutcome(result: ProcessedProjectSnapshot): void {
  const line = {
    event: 'project_snapshot_build',
    outcome: result.outcome,
    projectId: result.projectId,
    sha: result.commitSha,
    buildMs: result.buildMs,
    publishMs: result.publishMs,
    bytes: result.bytes,
    entries: result.entries,
    archive: result.archive,
    error: result.error,
  };
  if (result.outcome === 'ready') console.info('[project-snapshot] ready', line);
  else console.warn('[project-snapshot] build did not complete', line);
}

/** One pass: claim due rows and process them sequentially. Returns the count processed. */
export async function runProjectSnapshotWorkerOnce(
  workerId: string = WORKER_ID,
  batch: number = CLAIM_BATCH,
): Promise<ProcessedProjectSnapshot[]> {
  const ids = await claimProjectSnapshots(workerId, batch);
  const results: ProcessedProjectSnapshot[] = [];
  for (const snapshotId of ids) {
    const result = await processProjectSnapshot(snapshotId, workerId);
    if (result) {
      logOutcome(result);
      results.push(result);
    }
  }
  return results;
}

async function tick(): Promise<void> {
  if (stopped) return;
  let delay = IDLE_MS;
  try {
    const processed = await runProjectSnapshotWorkerOnce();
    // Drain a backlog promptly; sleep only when the queue was empty.
    if (processed.length > 0) delay = 250;
  } catch (err) {
    console.error('[project-snapshot] worker tick failed', err);
    delay = ERROR_MS;
  }
  if (stopped) return;
  timer = setTimeout(() => {
    activeTick = tick();
  }, delay);
}

export function startProjectSnapshotWorker(): void {
  if (running) return;
  if (!projectSnapshotStorageConfigured()) {
    console.info('[project-snapshot] worker idle: KORTIX_PROJECT_SNAPSHOT_S3_BUCKET is not configured');
    return;
  }
  running = true;
  stopped = false;
  activeTick = tick();
}

export async function stopProjectSnapshotWorker(): Promise<void> {
  if (!running) return;
  stopped = true;
  running = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  await activeTick?.catch(() => {});
  activeTick = null;
}
