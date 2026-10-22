/**
 * Leader-only worker that turns queued `project_snapshot_archives` rows into
 * published archives. Same shape as the other singleton workers
 * (`workers/audit-webhook-worker.ts`): a recursive `setTimeout` tick
 * (`workers/project-snapshot-worker.ts`) so a slow build can never overlap
 * the next tick in this process, `SKIP LOCKED` claims so a
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

const CLAIM_BATCH = 2;
const WORKER_ID = newProjectSnapshotWorkerId();

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
