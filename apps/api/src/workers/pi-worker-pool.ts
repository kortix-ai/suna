import { maintainPiWorkerPool, piWorkerPoolEnabled } from '../services/sandboxes/daytona/pi-worker-pool';

let maintainTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Leader-only periodic reconcile (bootstrap.ts singleton workers). The per-create
 * refill kick keeps the pool moving under load; this interval is the idle
 * safety net (initial fill after deploy, reap of over-age boxes overnight).
 */
export function startPiWorkerPoolMaintenance(): void {
  if (!piWorkerPoolEnabled() || maintainTimer) return;
  void maintainPiWorkerPool();
  maintainTimer = setInterval(() => void maintainPiWorkerPool(), 5 * 60_000);
  (maintainTimer as { unref?: () => void }).unref?.();
}

export function stopPiWorkerPoolMaintenance(): void {
  if (maintainTimer) {
    clearInterval(maintainTimer);
    maintainTimer = null;
  }
}
