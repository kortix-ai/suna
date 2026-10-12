import { runWorkerTick } from '../shared/audit-scope';
import { runAuditWebhookDeliveryPass } from '../shared/audit-webhooks';

const WORKER_IDLE_MS = 2_000;
const WORKER_ERROR_MS = 5_000;
let workerTimer: ReturnType<typeof setTimeout> | null = null;
let workerRunning = false;
let workerStopped = true;
let activeWorkerTick: Promise<void> | null = null;

async function workerTick(): Promise<void> {
  if (workerRunning || workerStopped) return;
  workerRunning = true;
  try {
    const claimed = await runAuditWebhookDeliveryPass();
    scheduleWorker(claimed > 0 ? 0 : WORKER_IDLE_MS);
  } catch (error) {
    console.warn('[audit-webhook] worker tick failed', error);
    scheduleWorker(WORKER_ERROR_MS);
  } finally {
    workerRunning = false;
  }
}

function scheduleWorker(delay: number): void {
  if (workerStopped || workerTimer) return;
  workerTimer = setTimeout(() => {
    workerTimer = null;
    const tick = runWorkerTick('audit-webhooks', workerTick);
    activeWorkerTick = tick;
    void tick.finally(() => {
      if (activeWorkerTick === tick) activeWorkerTick = null;
    });
  }, delay);
  workerTimer.unref?.();
}

/** Run the next tick now: a replayed delivery is due. A no-op unless this process runs the worker. */
export function wakeAuditWebhookWorker(): void {
  scheduleWorker(0);
}

export function startAuditWebhookWorker(): void {
  if (!workerStopped) return;
  workerStopped = false;
  scheduleWorker(0);
}

export async function stopAuditWebhookWorker(): Promise<void> {
  workerStopped = true;
  if (workerTimer) clearTimeout(workerTimer);
  workerTimer = null;
  await activeWorkerTick;
}
