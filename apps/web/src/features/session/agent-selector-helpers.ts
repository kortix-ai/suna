import { HARNESS_IDS } from '@kortix/shared/harnesses';

import type { ModelsPageRuntimeStatus } from '@kortix/sdk/react';

/**
 * Whether the agent picker should group rows under harness headings.
 * Grouping only earns its place once agents actually span more than one
 * harness — a single-harness project (the common case) gets a flat list
 * instead of a pointless one-group heading (2026-07-14 agent selector UX
 * pass). `null` entries (agents with no resolvable harness) count as their
 * own "other" bucket like the picker itself does.
 */
export function shouldGroupAgentsByHarness(harnesses: Array<string | null>): boolean {
  const distinct = new Set(harnesses.map((harness) => harness ?? 'other'));
  return distinct.size > 1;
}

/**
 * Display order for the agent picker's harness group headings: every
 * canonical harness in `HARNESS_IDS` order, followed by the catch-all
 * "other" bucket for agents with no resolvable harness. Derived from the
 * `@kortix/shared` harness descriptor — do not re-hardcode the harness tuple
 * here.
 */
export const AGENT_GROUP_ORDER: readonly [...typeof HARNESS_IDS, 'other'] = [...HARNESS_IDS, 'other'];

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
