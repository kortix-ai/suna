import { expect, test } from 'bun:test';
import type { RebuildSnapshotResponse, SandboxTemplate } from './sandbox';

test('SandboxTemplate types launch readiness independently for every supported provider', () => {
  const template = {
    provider_coverage: [
      {
        provider: 'e2b',
        available: true,
        snapshot_name: 'kortix-default-current',
        state: 'building',
        status: 'building',
        launch_ready: false,
        observed_at: '2026-07-13T12:00:00.000Z',
      },
    ],
  } satisfies Pick<SandboxTemplate, 'provider_coverage'>;

  expect(template.provider_coverage[0].provider).toBe('e2b');
  expect(template.provider_coverage[0].launch_ready).toBe(false);
});

test('rebuild responses type partial provider startup failures', () => {
  const response = {
    status: 'started',
    slug: 'default',
    deleted_existing: true,
    snapshot_name: 'kortix-default-current',
    providers: ['daytona', 'e2b'],
    failed_providers: ['platinum'],
  } satisfies RebuildSnapshotResponse;

  expect(response.providers).toEqual(['daytona', 'e2b']);
  expect(response.failed_providers).toEqual(['platinum']);
});
