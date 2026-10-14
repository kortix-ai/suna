import { runCaptureHealthTick } from '../capture/health-alerts';
import { runWorkerTick } from '../shared/audit-scope';
import { leaderTimer } from '../shared/leader-timer';

const TICK_MS = 60_000;

// Leader only: tells the people with capture.manage when a Capture computer stops
// recording or records again. Idempotent by inbox dedupe key (capture/health-alerts.ts).
const worker = leaderTimer(async () => {
  await runWorkerTick('capture-health', () => runCaptureHealthTick());
  return TICK_MS;
});

export const startCaptureHealthWorker = worker.start;
export const stopCaptureHealthWorker = worker.stop;
