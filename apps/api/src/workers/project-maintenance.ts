import { runWorkerTick } from '../services/audit/audit-scope';
import { maintenanceIntervalMs, runProjectMaintenance } from '../services/sandboxes/maintenance';

type MaintenanceTimer = ReturnType<typeof setInterval>;

const globalForProjectMaintenance = globalThis as typeof globalThis & {
  __kortixProjectMaintenanceTimer?: MaintenanceTimer | null;
};

let maintenanceTimer: MaintenanceTimer | null = null;

export function startProjectMaintenance(): void {
  if (process.env.KORTIX_PROJECT_MAINTENANCE_ENABLED === 'false') return;
  if (globalForProjectMaintenance.__kortixProjectMaintenanceTimer) {
    clearInterval(globalForProjectMaintenance.__kortixProjectMaintenanceTimer);
  }
  maintenanceTimer = setInterval(() => {
    runWorkerTick('project-maintenance', runProjectMaintenance).catch((err) => {
      console.error('[project-maintenance] run failed:', err);
    });
  }, maintenanceIntervalMs());
  globalForProjectMaintenance.__kortixProjectMaintenanceTimer = maintenanceTimer;
}

export function stopProjectMaintenance(): void {
  if (maintenanceTimer) {
    clearInterval(maintenanceTimer);
    maintenanceTimer = null;
  }
  if (globalForProjectMaintenance.__kortixProjectMaintenanceTimer) {
    clearInterval(globalForProjectMaintenance.__kortixProjectMaintenanceTimer);
    globalForProjectMaintenance.__kortixProjectMaintenanceTimer = null;
  }
}
