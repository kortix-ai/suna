import { runWorkspaceIdFillTick } from '../../workspaces/id-fill';
import { runWorkerTick } from '../../shared/audit-scope';
import { leaderTimer } from '../../shared/leader-timer';

// Leader only, serial: the Release 1 workspace_id fill (workspaces/id-fill.ts).
// One batch per tick, `pause_ms` (default 250 ms) between batches; hourly
// while paused (`workspace_id_fill` platform setting) or once finished. A
// failed batch rolls back with its progress and retries a minute later.
const worker = leaderTimer(
  async () => (await runWorkerTick('workspace-id-fill', () => runWorkspaceIdFillTick())).nextDelayMs,
  { name: 'workspace-id-fill' },
);

export const startWorkspaceIdFillWorker = worker.start;
export const stopWorkspaceIdFillWorker = worker.stop;
