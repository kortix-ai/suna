import { describe, expect, test } from 'bun:test';
import {
  enabledTemplateBuildProviders,
  observeTemplateProviderCoverage,
  resolveRoutedTemplateState,
  resolveUsableProjectProviderPin,
} from './provider-coverage';

describe('sandbox template provider coverage', () => {
  test('synchronizes reusable templates to every enabled provider regardless of routing pins', () => {
    expect(enabledTemplateBuildProviders({
      allowed: ['daytona', 'platinum', 'e2b'],
      isEnabled: () => true,
    })).toEqual(['daytona', 'platinum', 'e2b']);
    expect(enabledTemplateBuildProviders({
      allowed: ['daytona', 'platinum', 'e2b'],
      isEnabled: (provider) => provider !== 'platinum',
    })).toEqual(['daytona', 'e2b']);
  });

  test('observes the current image independently on Daytona, Platinum, and E2B', async () => {
    const calls: string[] = [];
    const states = { daytona: 'active', platinum: 'building', e2b: 'missing' } as const;

    const result = await observeTemplateProviderCoverage('kortix-default-current', {
      isProviderEnabled: () => true,
      getProvider: (provider) => ({
        getSnapshotState: async (snapshotName: string) => {
          calls.push(`${provider}:${snapshotName}`);
          return states[provider];
        },
      }),
      now: () => new Date('2026-07-13T12:00:00.000Z'),
    });

    expect(calls).toEqual([
      'daytona:kortix-default-current',
      'platinum:kortix-default-current',
      'e2b:kortix-default-current',
    ]);
    expect(result.map(({ provider, status, launch_ready }) => ({ provider, status, launch_ready })))
      .toEqual([
        { provider: 'daytona', status: 'ready', launch_ready: true },
        { provider: 'platinum', status: 'building', launch_ready: false },
        { provider: 'e2b', status: 'not_built', launch_ready: false },
      ]);
  });

  test('automatic routing is ready only when every enabled provider is launch ready', () => {
    const coverage = [
      { provider: 'daytona', available: true, state: 'active' },
      { provider: 'platinum', available: true, state: 'active' },
      { provider: 'e2b', available: true, state: 'building' },
    ] as const;

    expect(resolveRoutedTemplateState(coverage, null)).toBe('building');
    expect(resolveRoutedTemplateState(coverage, 'daytona')).toBe('active');
  });

  test('disabled providers are unavailable and do not block automatic readiness', async () => {
    const result = await observeTemplateProviderCoverage('snapshot', {
      isProviderEnabled: (provider) => provider === 'e2b',
      getProvider: () => ({ getSnapshotState: async () => 'active' }),
      now: () => new Date('2026-07-13T12:00:00.000Z'),
    });

    expect(result.find((item) => item.provider === 'daytona')).toMatchObject({
      available: false,
      status: 'unavailable',
      observed_at: null,
    });
    expect(resolveRoutedTemplateState(result, null)).toBe('active');
  });

  test('provider probe failures stay unknown rather than claiming not built', async () => {
    const result = await observeTemplateProviderCoverage('snapshot', {
      isProviderEnabled: () => true,
      getProvider: () => ({ getSnapshotState: async () => { throw new Error('timeout'); } }),
      now: () => new Date('2026-07-13T12:00:00.000Z'),
    });

    expect(result.every((item) => item.status === 'unknown')).toBe(true);
    expect(result.every((item) => item.state === null)).toBe(true);
  });

  test('only treats a usable explicit project pin as pinned', () => {
    const enabled = (provider: string) => provider !== 'e2b';
    expect(resolveUsableProjectProviderPin({}, enabled)).toBeNull();
    expect(resolveUsableProjectProviderPin({ default_sandbox_provider: 'platinum' }, enabled))
      .toBe('platinum');
    expect(resolveUsableProjectProviderPin({ default_sandbox_provider: 'e2b' }, enabled))
      .toBeNull();
    expect(resolveUsableProjectProviderPin({ default_sandbox_provider: 'bogus' }, enabled))
      .toBeNull();
  });
});
