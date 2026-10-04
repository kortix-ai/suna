import { describe, expect, mock, test } from 'bun:test';
import { TimeoutError } from '../shared/with-timeout';

/**
 * GET /v1/projects/:id/resource-grants loads the project's git-backed config
 * on the request path. A mirror re-clone after the reaper's LRU eviction, a
 * stalled fetch or a slow auth mint holds the picker for tens of seconds —
 * KRTX-821 measured that tail at the 25 s request deadline (p95 25005 ms).
 * The picker read must answer inside a bounded budget instead: the cached
 * loader (20 s TTL, in-flight dedup) wrapped in the wall-clock bound, whose
 * rejection is the config-load failure the handler already degrades on.
 * The losing load keeps running and the TTL memo keeps its result for the
 * next read.
 */

// Evaluated once at route-module load; the tests run against the floor budget.
process.env.KORTIX_RESOURCE_GRANTS_CONFIG_BUDGET_MS = '1000';

const real = await import('../projects/lib/project-resources');

/** The cached loader, stubbed at the exact seam the route imports. */
let hangConfigLoad = true;
mock.module('../projects/lib/project-resources', () => ({
  ...real,
  loadConfigWithFilesCached: () =>
    hangConfigLoad
      ? new Promise(() => {})
      : Promise.resolve({ agents: [], skills: [] }),
}));

const route = await import('../projects/routes/resource-grants');

type PickerRow = Parameters<typeof route.loadPickerConfig>[0];
// The stub ignores the row; only the shape the route module forwards matters.
const ROW = { projectId: '00000000-0000-4000-8000-000000000001', defaultBranch: 'main' } as PickerRow;

describe('loadPickerConfig — the picker read never waits unbounded on git work', () => {
  test('a load that hangs past the budget rejects with TimeoutError', async () => {
    hangConfigLoad = true;
    await expect(route.loadPickerConfig(ROW)).rejects.toBeInstanceOf(TimeoutError);
  }, 5_000);

  test('a load that settles inside the budget resolves', async () => {
    hangConfigLoad = false;
    const config = await route.loadPickerConfig(ROW);
    expect(config.agents).toEqual([]);
    expect(config.skills).toEqual([]);
  });
});
