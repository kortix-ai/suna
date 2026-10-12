import { runProjectSnapshotWorkerOnce } from '../git-proxy/project-snapshot-worker';
import { projectSnapshotStorageConfigured } from '../git-proxy/project-snapshot-store';
import { runWorkerTick } from '../shared/audit-scope';

const IDLE_MS = 5_000;
const ERROR_MS = 15_000;

let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let stopped = true;
let activeTick: Promise<void> | null = null;

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
    activeTick = runWorkerTick('project-snapshots', tick);
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
  activeTick = runWorkerTick('project-snapshots', tick);
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
