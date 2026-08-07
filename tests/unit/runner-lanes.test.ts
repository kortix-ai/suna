import { describe, expect, it } from 'vitest';
import type { RegisteredFlow } from '../src/core/flow';
import { partitionParallelFlows } from '../src/core/lanes';
import { mapWithConcurrency } from '../src/core/concurrency';
import { formatFlowProgress, redactSensitiveLogText } from '../src/core/progress';

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

  it('redacts secret query values from progress diagnostics', () => {
    const reason =
      'network error GET https://preview.test/path?token=share-secret&code=oauth-secret&safe=value: timed out';

    const redacted = redactSensitiveLogText(reason);

    expect(redacted).not.toContain('share-secret');
    expect(redacted).not.toContain('oauth-secret');
    expect(redacted).toContain('token=[REDACTED]');
    expect(redacted).toContain('code=[REDACTED]');
    expect(redacted).toContain('safe=value');
  });

  it('redacts secret query values in formatted failure reasons', () => {
    const output = formatFlowProgress(
      {
        id: 'RUN-8',
        domain: 'sessions',
        tags: [],
        status: 'fail',
        reason: 'GET https://preview.test/?access_token=runtime-secret failed',
        durationMs: 1_000,
        attempts: 1,
        steps: [],
      },
      1,
      1,
    );

    expect(output).not.toContain('runtime-secret');
    expect(output).toContain('access_token=[REDACTED]');
  });
});
