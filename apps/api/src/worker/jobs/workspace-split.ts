import { processWorkspaceSplits } from '../../workspaces/split/split-runner';
import { runWorkerTick } from '../../shared/audit-scope';
import { leaderTimer } from '../../shared/leader-timer';

// Leader only, serial: the workspace split (workspaces/split/split-runner.ts).
// `off` idles an hour between checks of the mode, `dry_run` plans every 6
// hours, `apply` moves up to 5 projects a pass and comes back a minute later
// while a backlog lasts. The mode is WORKSPACE_SPLIT_MODE, overridden at
// runtime by the `workspace_split` platform setting. The tick always runs
// inside runWorkerTick, so the heartbeat sees it in every mode.
const worker = leaderTimer(
  async () => (await runWorkerTick('workspace-split', () => processWorkspaceSplits())).nextDelayMs,
  { name: 'workspace-split' },
);

export const startWorkspaceSplitWorker = worker.start;
export const stopWorkspaceSplitWorker = worker.stop;
