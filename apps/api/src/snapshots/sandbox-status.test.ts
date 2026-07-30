import { describe, expect, test } from 'bun:test';
import {
  type SandboxStatusBuild,
  type SandboxStatusCoverage,
  pickPrimaryTemplate,
  resolveSandboxRuntimeStatus,
} from './sandbox-status';

const CURRENT = 'kortix-default-3e3906a27df1';
const PREVIOUS = 'kortix-default-11e780692c1d';

function coverage(
  provider: string,
  status: SandboxStatusCoverage['status'],
  overrides: Partial<SandboxStatusCoverage> = {},
): SandboxStatusCoverage {
  return {
    provider,
    available: status !== 'unavailable',
    status,
    launch_ready: status === 'ready',
    ...overrides,
  };
}

function build(overrides: Partial<SandboxStatusBuild> = {}): SandboxStatusBuild {
  return { slug: 'default', snapshotName: CURRENT, status: 'ready', ...overrides };
}

describe('resolveSandboxRuntimeStatus', () => {
  test('is ready when every routable provider holds the current image', () => {
    const status = resolveSandboxRuntimeStatus({
      snapshotName: CURRENT,
      coverage: [coverage('daytona', 'ready'), coverage('platinum', 'ready')],
      selectedProvider: null,
      builds: [build()],
    });

    expect(status.state).toBe('ready');
    expect(status.current_failure).toBeNull();
    expect(status.ready_providers).toEqual(['daytona', 'platinum']);
  });

  // The reported bug: a failed build from 11 days ago rendered as "the most
  // recent build is failing" while the image it names was live on Platinum.
  test('never reports a failure the provider has since proven wrong', () => {
    const failure = build({ status: 'failed', snapshotName: CURRENT });

    const status = resolveSandboxRuntimeStatus({
      snapshotName: CURRENT,
      coverage: [coverage('daytona', 'building'), coverage('platinum', 'ready')],
      selectedProvider: null,
      builds: [failure, build({ snapshotName: PREVIOUS })],
    });

    expect(status.state).toBe('building');
    expect(status.current_failure).toBeNull();
    expect(status.stale_failure).toBe(failure);
    expect(status.stale_reason).toBe('retrying');
  });

  test('treats a failure against a previous definition as superseded history', () => {
    const failure = build({ status: 'failed', snapshotName: PREVIOUS });

    const status = resolveSandboxRuntimeStatus({
      snapshotName: CURRENT,
      coverage: [coverage('daytona', 'ready'), coverage('platinum', 'ready')],
      selectedProvider: null,
      builds: [failure],
    });

    expect(status.state).toBe('ready');
    expect(status.current_failure).toBeNull();
    expect(status.stale_failure).toBe(failure);
    expect(status.stale_reason).toBe('superseded');
  });

  test('marks a failure recovered when its own image is now live', () => {
    const failure = build({ status: 'failed', snapshotName: CURRENT });

    const status = resolveSandboxRuntimeStatus({
      snapshotName: CURRENT,
      coverage: [coverage('daytona', 'ready'), coverage('platinum', 'ready')],
      selectedProvider: null,
      builds: [failure],
    });

    expect(status.state).toBe('ready');
    expect(status.stale_reason).toBe('recovered');
  });

  test('blocks when the current image failed and exists nowhere routable', () => {
    const failure = build({ status: 'failed', snapshotName: CURRENT });

    const status = resolveSandboxRuntimeStatus({
      snapshotName: CURRENT,
      coverage: [coverage('daytona', 'failed'), coverage('platinum', 'not_built')],
      selectedProvider: null,
      builds: [failure],
    });

    expect(status.state).toBe('blocked');
    expect(status.current_failure).toBe(failure);
    expect(status.stale_failure).toBeNull();
    expect(status.failed_providers).toEqual(['daytona']);
  });

  test('degrades rather than blocks when one provider failed and another is ready', () => {
    const failure = build({ status: 'failed', snapshotName: CURRENT });

    const status = resolveSandboxRuntimeStatus({
      snapshotName: CURRENT,
      coverage: [coverage('daytona', 'failed'), coverage('platinum', 'ready')],
      selectedProvider: null,
      builds: [failure],
    });

    expect(status.state).toBe('degraded');
    expect(status.current_failure).toBe(failure);
  });

  test('a pinned project follows only its pin', () => {
    const failure = build({ status: 'failed', snapshotName: CURRENT });
    const args = {
      snapshotName: CURRENT,
      coverage: [coverage('daytona', 'failed'), coverage('platinum', 'ready')],
      builds: [failure],
    };

    expect(resolveSandboxRuntimeStatus({ ...args, selectedProvider: 'platinum' }).state).toBe(
      'ready',
    );
    expect(resolveSandboxRuntimeStatus({ ...args, selectedProvider: 'daytona' }).state).toBe(
      'blocked',
    );
  });

  test('a provider probe blip is never evidence of a broken sandbox', () => {
    const status = resolveSandboxRuntimeStatus({
      snapshotName: CURRENT,
      coverage: [coverage('daytona', 'unknown'), coverage('platinum', 'unknown')],
      selectedProvider: null,
      builds: [build({ status: 'failed', snapshotName: CURRENT })],
    });

    expect(status.state).toBe('unknown');
    expect(status.current_failure).toBeNull();
  });

  test('an unbuilt image with no failure waits for the next session, quietly', () => {
    const status = resolveSandboxRuntimeStatus({
      snapshotName: CURRENT,
      coverage: [coverage('daytona', 'not_built'), coverage('platinum', 'not_built')],
      selectedProvider: null,
      builds: [],
    });

    expect(status.state).toBe('not_built');
    expect(status.current_failure).toBeNull();
  });

  test('falls back to the current identity build log when nothing could be observed', () => {
    const failure = build({ status: 'failed', snapshotName: CURRENT });

    expect(
      resolveSandboxRuntimeStatus({
        snapshotName: CURRENT,
        coverage: null,
        selectedProvider: null,
        builds: [failure],
      }).state,
    ).toBe('blocked');

    // …but a stale row for a definition nobody boots stays history even there.
    expect(
      resolveSandboxRuntimeStatus({
        snapshotName: CURRENT,
        coverage: null,
        selectedProvider: null,
        builds: [build({ status: 'failed', snapshotName: PREVIOUS })],
      }).state,
    ).toBe('unknown');
  });

  test('ignores providers the platform has not enabled', () => {
    const status = resolveSandboxRuntimeStatus({
      snapshotName: CURRENT,
      coverage: [coverage('daytona', 'ready'), coverage('e2b', 'unavailable')],
      selectedProvider: null,
      builds: [build()],
    });

    expect(status.state).toBe('ready');
  });
});

describe('pickPrimaryTemplate', () => {
  const templates = [{ slug: 'default' }, { slug: 'gpu' }];

  test('prefers the project declared default', () => {
    expect(pickPrimaryTemplate(templates, 'gpu')?.slug).toBe('gpu');
  });

  test('falls back to the platform default when the declared one is gone', () => {
    expect(pickPrimaryTemplate(templates, 'deleted')?.slug).toBe('default');
    expect(pickPrimaryTemplate(templates, null)?.slug).toBe('default');
    expect(pickPrimaryTemplate([], 'gpu')).toBeNull();
  });
});
