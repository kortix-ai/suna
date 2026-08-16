import { describe, expect, test } from 'bun:test';
import { resolveInvariantProviderStatus } from './compute-invariant-sweep';

describe('compute invariant provider dispatch', () => {
  test('routes a Lightsail App candidate through AppHostingService', async () => {
    const calls: string[] = [];
    const result = await resolveInvariantProviderStatus({
      isApp: true,
      sandboxId: 'runtime-1',
      hostingType: 'managed_container',
      provider: 'aws_lightsail',
      externalId: 'kortix-test-app-runtime',
    }, {
      status: async (target: { hostingType: string; provider: string; externalId: string }) => {
        calls.push(`app:${target.hostingType}:${target.provider}:${target.externalId}`);
        return 'running';
      },
    } as never, async () => {
      calls.push('sandbox-registry');
      return 'terminal';
    });

    expect(result).toBe('running');
    expect(calls).toEqual([
      'app:managed_container:aws_lightsail:kortix-test-app-runtime',
    ]);
  });

  test('keeps a sandbox candidate on the sandbox provider path', async () => {
    const calls: string[] = [];
    const result = await resolveInvariantProviderStatus({
      isApp: false,
      sandboxId: 'sandbox-1',
      hostingType: null,
      provider: 'platinum',
      externalId: 'box-1',
    }, {
      status: async () => {
        calls.push('app-dispatcher');
        return 'terminal';
      },
    } as never, async (provider, externalId) => {
      calls.push(`sandbox:${provider}:${externalId}`);
      return 'running';
    });

    expect(result).toBe('running');
    expect(calls).toEqual(['sandbox:platinum:box-1']);
  });
});
