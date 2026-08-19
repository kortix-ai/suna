import { describe, expect, test } from 'bun:test';

import type { ProjectSandboxHealth, ProjectSnapshotBuild, SandboxRuntimeStatus } from '@kortix/sdk';
import {
  describeFailedBuild,
  formatSandboxProviders,
  resolveSandboxAlertSeverity,
  sandboxHealthIsActive,
  selectCurrentSandboxFailure,
} from './sandbox-alert-state';

const CURRENT = 'kortix-default-3e3906a27df1';
const PREVIOUS = 'kortix-default-11e780692c1d';

function build(overrides: Partial<ProjectSnapshotBuild>): ProjectSnapshotBuild {
  return {
    build_id: 'build-1',
    slug: 'default',
    template_slug: 'default',
    snapshot_name: CURRENT,
    content_hash: 'hash',
    status: 'ready',
    error: null,
    error_category: null,
    fixable_by_agent: false,
    source: 'manual',
    started_at: '2026-07-18T00:00:00.000Z',
    finished_at: '2026-07-18T00:01:00.000Z',
    ...overrides,
  };
}

function status(overrides: Partial<SandboxRuntimeStatus>): SandboxRuntimeStatus {
  return {
    state: 'ready',
    snapshot_name: CURRENT,
    current_failure: null,
    stale_failure: null,
    stale_reason: null,
    ready_providers: ['daytona', 'platinum'],
    building_providers: [],
    failed_providers: [],
    fix_with_agent_available: false,
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
    status: null,
    ...overrides,
  };
}

describe('resolveSandboxAlertSeverity', () => {
  // The reported bug: an 11-day-old failed build kept a red "Fix sandbox build"
  // alert up while a ready image was serving every session.
  test('stays silent when the newest failed build no longer applies', () => {
    const stale = build({ build_id: 'failed-11d', status: 'failed', snapshot_name: PREVIOUS });

    expect(
      resolveSandboxAlertSeverity(
        health({
          latest_failure: stale,
          status: status({ state: 'ready', stale_failure: stale, stale_reason: 'superseded' }),
        }),
      ),
    ).toBeNull();
  });

  test('is critical only when nothing bootable is left', () => {
    const failure = build({ status: 'failed' });

    expect(
      resolveSandboxAlertSeverity(
        health({ status: status({ state: 'blocked', current_failure: failure }) }),
      ),
    ).toBe('critical');
  });

  test('warns rather than alarms when only some providers are failing', () => {
    expect(
      resolveSandboxAlertSeverity(
        health({
          status: status({
            state: 'degraded',
            ready_providers: ['platinum'],
            failed_providers: ['daytona'],
          }),
        }),
      ),
    ).toBe('warning');
  });

  test('shows a quiet building state, and nothing at all when healthy', () => {
    expect(resolveSandboxAlertSeverity(health({ status: status({ state: 'building' }) }))).toBe(
      'building',
    );
    expect(resolveSandboxAlertSeverity(health({ status: status({ state: 'ready' }) }))).toBeNull();
    expect(
      resolveSandboxAlertSeverity(health({ status: status({ state: 'not_built' }) })),
    ).toBeNull();
    expect(
      resolveSandboxAlertSeverity(health({ status: status({ state: 'unknown' }) })),
    ).toBeNull();
  });

  test('a degraded or older API response never invents an alert', () => {
    expect(resolveSandboxAlertSeverity(health({}))).toBeNull();
    expect(resolveSandboxAlertSeverity(null)).toBeNull();
    // Even with a failed row in the payload the UI stays quiet without a status.
    expect(
      resolveSandboxAlertSeverity(health({ latest_failure: build({ status: 'failed' }) })),
    ).toBeNull();
  });
});

describe('selectCurrentSandboxFailure', () => {
  test('reads the failure that still applies, never the newest failed row', () => {
    const stale = build({ build_id: 'stale', status: 'failed', snapshot_name: PREVIOUS });
    const blocking = build({ build_id: 'blocking', status: 'failed' });

    expect(selectCurrentSandboxFailure(health({ latest_failure: stale }))).toBeNull();
    expect(
      selectCurrentSandboxFailure(
        health({ latest_failure: stale, status: status({ stale_failure: stale }) }),
      ),
    ).toBeNull();
    expect(
      selectCurrentSandboxFailure(
        health({ status: status({ state: 'blocked', current_failure: blocking }) }),
      ),
    ).toBe(blocking);
  });
});

describe('sandboxHealthIsActive', () => {
  test('polls fast only while something is in motion or broken', () => {
    expect(sandboxHealthIsActive(health({ status: status({ state: 'building' }) }))).toBe(true);
    expect(sandboxHealthIsActive(health({ status: status({ state: 'blocked' }) }))).toBe(true);
    expect(sandboxHealthIsActive(health({ status: status({ state: 'degraded' }) }))).toBe(true);
    expect(sandboxHealthIsActive(health({ status: status({ state: 'ready' }) }))).toBe(false);
    expect(sandboxHealthIsActive(health({}))).toBe(false);
  });
});

describe('describeFailedBuild', () => {
  const blocking = build({ build_id: 'blocking', status: 'failed' });

  test('separates a live failure from history', () => {
    const current = status({ state: 'blocked', current_failure: blocking });

    expect(describeFailedBuild(blocking, current)).toBe('blocking');
    expect(
      describeFailedBuild(
        build({ build_id: 'old', status: 'failed', snapshot_name: PREVIOUS }),
        current,
      ),
    ).toBe('superseded');
  });

  test('echoes the API verdict for the newest failure that no longer applies', () => {
    const stale = build({ build_id: 'stale', status: 'failed' });

    expect(
      describeFailedBuild(
        stale,
        status({ state: 'ready', stale_failure: stale, stale_reason: 'recovered' }),
      ),
    ).toBe('recovered');
    expect(
      describeFailedBuild(
        stale,
        status({ state: 'building', stale_failure: stale, stale_reason: 'retrying' }),
      ),
    ).toBe('retrying');
  });

  test('says nothing about builds that did not fail, or without a status', () => {
    expect(describeFailedBuild(build({ status: 'ready' }), status({}))).toBeNull();
    expect(describeFailedBuild(build({ status: 'building' }), status({}))).toBeNull();
    expect(describeFailedBuild(blocking, null)).toBeNull();
  });
});

describe('formatSandboxProviders', () => {
  test('reads as prose', () => {
    expect(formatSandboxProviders([])).toBe('');
    expect(formatSandboxProviders(['daytona'])).toBe('Daytona');
    expect(formatSandboxProviders(['daytona', 'e2b'])).toBe('Daytona and E2B');
    expect(formatSandboxProviders(['daytona', 'e2b', 'platinum'])).toBe(
      'Daytona, E2B and Platinum',
    );
  });
});
