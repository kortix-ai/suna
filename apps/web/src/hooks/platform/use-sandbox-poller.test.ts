import { describe, expect, test } from 'bun:test';

import { fetchSandboxGlobalHealth } from './runtime-health';

describe('ACP-neutral sandbox readiness', () => {
  test('probes the Kortix daemon and accepts runtimeReady', async () => {
    let requested = '';
    const health = await fetchSandboxGlobalHealth(
      'https://sandbox.example',
      undefined,
      async (input) => {
        requested = String(input);
        return new Response(JSON.stringify({ runtimeReady: true, version: '1.2.3' }));
      },
    );

    expect(requested).toBe('https://sandbox.example/kortix/health');
    expect(health).toEqual({ healthy: true, version: '1.2.3' });
  });
});
