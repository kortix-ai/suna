import { describe, expect, test } from 'bun:test';

import { createUnsupportedInstanceHealth } from '../platform/services/instance-health';

describe('createUnsupportedInstanceHealth', () => {
  test('returns a non-error fallback payload for unsupported providers', () => {
    const health = createUnsupportedInstanceHealth('sandbox-123', 'local_docker');

    expect(health).toMatchObject({
      sandbox_id: 'sandbox-123',
      overall_status: 'unknown',
      recommended_action: null,
      layers: {
        host: {
          status: 'unknown',
          details: { provider: 'local_docker', supported: false },
        },
        workload: {
          status: 'unknown',
          details: { provider: 'local_docker', supported: false },
        },
        runtime: {
          status: 'unknown',
          details: { provider: 'local_docker', supported: false },
        },
      },
    });
    expect(health.layers.host.summary).toContain('local_docker');
    expect(health.layers.workload.actions).toHaveLength(0);
    expect(health.layers.runtime.actions).toHaveLength(0);
  });
});
