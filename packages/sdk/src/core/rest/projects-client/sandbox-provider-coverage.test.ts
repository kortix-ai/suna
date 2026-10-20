import { expect, test } from 'bun:test';
import type { RebuildSnapshotResponse, SandboxTemplate } from './sandbox';

test('SandboxTemplate types launch readiness independently for every supported provider', () => {
  const template = {
    provider_coverage: [
      {
        provider: 'platinum',
        available: true,
        snapshot_name: 'kortix-default-current',
        state: 'building',
        status: 'building',
        launch_ready: false,
        observed_at: '2026-07-13T12:00:00.000Z',
      },
    ],
  } satisfies Pick<SandboxTemplate, 'provider_coverage'>;

  expect(template.provider_coverage[0].provider).toBe('platinum');
  expect(template.provider_coverage[0].launch_ready).toBe(false);
});

test('rebuild responses type partial provider startup failures', () => {
  const response = {
    status: 'started',
    slug: 'default',
    deleted_existing: true,
    snapshot_name: 'kortix-default-current',
    providers: ['platinum'],
    failed_providers: ['daytona'],
  } satisfies RebuildSnapshotResponse;

  expect(response.providers).toEqual(['platinum']);
  expect(response.failed_providers).toEqual(['daytona']);
});
