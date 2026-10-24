import { MEMORY_MAINTENANCE_BATCH, runMemoryMaintenance } from '../memory/maintenance';
import { runWorkerTick } from '../shared/audit-scope';
import { leaderTimer } from '../shared/leader-timer';

const IDLE_MS = 60 * 60_000;
const BACKLOG_MS = 5_000;

// Leader only, serial: memory pages 30 days in the trash are deleted for good, and
// each page keeps its newest 100 versions. A full batch means a backlog, so the
// next pass comes in seconds.
const worker = leaderTimer(
  async () => {
    const result = await runWorkerTick('memory-maintenance', () => runMemoryMaintenance());
    return result.pages >= MEMORY_MAINTENANCE_BATCH || result.versions >= MEMORY_MAINTENANCE_BATCH ? BACKLOG_MS : IDLE_MS;
  },
  { name: 'memory-maintenance' },
);

export const startMemoryMaintenanceWorker = worker.start;
export const stopMemoryMaintenanceWorker = worker.stop;
