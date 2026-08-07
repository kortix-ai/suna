import { describe, expect, it } from 'vitest';
import type { RegisteredFlow } from '../src/core/flow';
import { partitionParallelFlows } from '../src/core/lanes';
import { mapWithConcurrency } from '../src/core/concurrency';
import { formatFlowProgress } from '../src/core/progress';

function registeredFlow(
  id: string,
  requires: RegisteredFlow['meta']['requires'] = [],
): RegisteredFlow {
  return {
    id,
    meta: { domain: 'test', requires },
    fn: async () => {},
  };
}

describe('ke2e parallel lanes', () => {
  it('separates live sandbox flows from API-only flows', () => {
    const api = registeredFlow('API-1');
    const fundedApi = registeredFlow('API-2', ['funded']);
    const daytona = registeredFlow('SBX-1', ['funded', 'daytona']);

    const lanes = partitionParallelFlows([api, daytona, fundedApi]);

    expect(lanes.apiLane).toEqual([api, fundedApi]);
    expect(lanes.sandboxLane).toEqual([daytona]);
  });

  it('bounds concurrency and preserves result order', async () => {
    let active = 0;
    let maxActive = 0;

    const results = await mapWithConcurrency([3, 1, 2, 4], 2, async (value) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, value));
      active--;
      return value * 10;
    });

    expect(maxActive).toBe(2);
    expect(results).toEqual([30, 10, 20, 40]);
  });

  it('renders bounded per-flow completion diagnostics', () => {
    expect(
      formatFlowProgress(
        {
          id: 'SESS-1',
          domain: 'sessions',
          tags: [],
          status: 'fail',
          reason: 'flow SESS-1 exceeded 120000ms',
          durationMs: 240_123,
          attempts: 2,
          steps: [],
        },
        17,
        375,
      ),
    ).toBe('[17/375] FAIL SESS-1 240.1s attempts=2 — flow SESS-1 exceeded 120000ms');
  });
});
