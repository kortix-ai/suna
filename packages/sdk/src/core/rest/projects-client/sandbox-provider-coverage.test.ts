import { expect, test } from 'bun:test';
import type { SandboxTemplate } from './sandbox';

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
