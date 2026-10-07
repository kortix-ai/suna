import { triggerAppDeploymentWorker } from '../apps/deployment-worker';

const workerState = globalThis as unknown as {
  __kortixAppsWorkerTimer?: ReturnType<typeof setInterval> | null;
};

export function startAppDeploymentWorker(): void {
  if (process.env.KORTIX_APPS_WORKER_ENABLED === 'false') return;
  stopAppDeploymentWorker();
  const interval = Math.max(1_000, Number(process.env.KORTIX_APPS_WORKER_INTERVAL_MS) || 5_000);
  triggerAppDeploymentWorker();
  workerState.__kortixAppsWorkerTimer = setInterval(() => {
    triggerAppDeploymentWorker();
  }, interval);
}

export function stopAppDeploymentWorker(): void {
  if (workerState.__kortixAppsWorkerTimer) {
    clearInterval(workerState.__kortixAppsWorkerTimer);
    workerState.__kortixAppsWorkerTimer = null;
  }
}
