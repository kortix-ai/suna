import { describe, expect, test } from 'bun:test';

import type { ProjectSandboxHealth, ProjectSnapshotBuild } from '@kortix/sdk/projects-client';
import {
  currentFailedBuild,
  resolveSandboxAlertSeverity,
  selectCurrentSandboxFailure,
} from './sandbox-alert-state';

function build(overrides: Partial<ProjectSnapshotBuild>): ProjectSnapshotBuild {
  return {
    build_id: 'build-1',
    slug: 'default',
    template_slug: 'default',
    snapshot_name: 'kortix-default-123',
    content_hash: 'hash',
    status: 'ready',
    error: null,
    error_category: null,
    fixable_by_agent: false,
    source: 'manual',
    started_at: '2026-07-11T00:00:00.000Z',
    finished_at: '2026-07-11T00:01:00.000Z',
    ...overrides,
  };
}

function health(overrides: Partial<ProjectSandboxHealth>): ProjectSandboxHealth {
  return {
    primary_slug: 'default',
    primary_template: null,
    ready: false,
    building: false,
    latest_build: null,
    latest_failure: null,
    ...overrides,
  };
}

describe('selectCurrentSandboxFailure', () => {
  test('keeps a failed latest build actionable', () => {
    const failed = build({ build_id: 'failed-latest', status: 'failed' });

    expect(
      selectCurrentSandboxFailure(health({ latest_build: failed, latest_failure: failed })),
    ).toBe(failed);
  });

  test('drops an older failed build when a newer build is ready', () => {
    const latestReady = build({ build_id: 'ready-latest', status: 'ready' });
    const oldFailure = build({ build_id: 'failed-older', status: 'failed' });

    expect(
      selectCurrentSandboxFailure(
        health({ latest_build: latestReady, latest_failure: oldFailure, ready: false }),
      ),
    ).toBeNull();
  });
});

describe('resolveSandboxAlertSeverity', () => {
  test('does not show the red fix alert for stale failed history', () => {
    const latestReady = build({ build_id: 'ready-latest', status: 'ready' });
    const oldFailure = build({ build_id: 'failed-older', status: 'failed' });

    expect(
      resolveSandboxAlertSeverity(
        health({ latest_build: latestReady, latest_failure: oldFailure, ready: false }),
      ),
    ).toBeNull();
  });

  test('shows building when a newer build is running after an older failure', () => {
    const latestBuilding = build({ build_id: 'building-latest', status: 'building' });
    const oldFailure = build({ build_id: 'failed-older', status: 'failed' });

    expect(
      resolveSandboxAlertSeverity(
        health({ latest_build: latestBuilding, latest_failure: oldFailure, building: true }),
      ),
    ).toBe('building');
  });
});

describe('currentFailedBuild', () => {
  test('returns the failed build only when it is the newest row', () => {
    const failed = build({ build_id: 'failed-latest', status: 'failed' });
    expect(currentFailedBuild([failed, build({ build_id: 'ready-older' })])).toBe(failed);
  });

  test('ignores older failed rows after a newer ready build', () => {
    expect(
      currentFailedBuild([
        build({ build_id: 'ready-latest', status: 'ready' }),
        build({ build_id: 'failed-older', status: 'failed' }),
      ]),
    ).toBeNull();
  });
});
