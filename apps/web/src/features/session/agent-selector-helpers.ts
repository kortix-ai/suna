import type { ModelsPageRuntimeStatus } from '@kortix/sdk/react';

/**
 * Whether the agent picker's row-level "no model connected" dot should show
 * for a harness, given that harness's `useModelsPage().runtimes[].status`
 * (Task 8's per-harness connection status). `ready` (usable) and `checking`
 * (still resolving — showing a dot here would be a false alarm) are the only
 * statuses that suppress it; `missing`, `ambiguous`, `needs-attention`, and
 * `unavailable` all mean the harness has no usable connection right now.
 * `undefined` (no runtime entry resolved for this harness — e.g. no project
 * context wired to the picker yet) is treated as unknown, not disconnected,
 * so the dot never renders on stale/absent data.
 */
export function isHarnessDisconnected(status: ModelsPageRuntimeStatus | undefined): boolean {
  if (!status) return false;
  return status !== 'ready' && status !== 'checking';
}
