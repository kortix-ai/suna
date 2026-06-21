/**
 * Unit coverage for snapshot build error classification. Pure function, no
 * mocks — pins the buckets the dashboard + fix-with-agent flow route on.
 */

import { describe, expect, test } from 'bun:test';
import {
  classifySnapshotError,
  describeSnapshotError,
} from '../snapshots/error-classify';

describe('classifySnapshotError', () => {
  test('empty / null → unknown', () => {
    expect(classifySnapshotError('')).toBe('unknown');
    expect(classifySnapshotError(null)).toBe('unknown');
    expect(classifySnapshotError(undefined)).toBe('unknown');
  });

  test('Dockerfile build failures', () => {
    expect(classifySnapshotError('failed to solve: process "/bin/sh -c apt-get install" did not complete successfully: exit code: 100')).toBe('dockerfile');
    expect(classifySnapshotError('Empty Dockerfile at .kortix/Dockerfile (commit abcd1234)')).toBe('dockerfile');
    expect(classifySnapshotError('COPY failed: no such file or directory')).toBe('dockerfile');
  });

  test('missing Kortix runtime artifacts', () => {
    expect(classifySnapshotError('Required artifact missing: /path/kortix-agent. Set KORTIX_SNAPSHOT_AGENT_BIN_PATH')).toBe('runtime');
    expect(classifySnapshotError('Required directory missing: agent-cli')).toBe('runtime');
  });

  test('dead tunnel / unreachable callback', () => {
    expect(classifySnapshotError('KORTIX_URL is a loopback address and unreachable from the sandbox')).toBe('tunnel');
    expect(classifySnapshotError('cloudflared tunnel is down')).toBe('tunnel');
  });

  test('git / repo resolution', () => {
    expect(classifySnapshotError('could not resolve commit for ref main')).toBe('git');
    expect(classifySnapshotError('fatal: repository not found')).toBe('git');
    expect(classifySnapshotError('GitHub App not installed for this account')).toBe('git');
  });

  test('timeouts / orphaned builds', () => {
    expect(classifySnapshotError('build orphaned (API restart or timeout) — rebuilds on next use')).toBe('timeout');
    expect(classifySnapshotError('build timed out after 600s')).toBe('timeout');
  });

  test('Daytona provider / transport errors', () => {
    expect(classifySnapshotError('Your socket connection to the server was not read from or written to within the timeout period')).toBe('timeout'); // timeout wins, both non-fixable
    expect(classifySnapshotError('daytona snapshot.create failed: bad gateway 502')).toBe('provider');
    expect(classifySnapshotError('Snapshot with name kortix-snap-22d94e6f-933a11278b8e not found')).toBe('provider');
    expect(classifySnapshotError('ECONNRESET')).toBe('provider');
  });
});

describe('describeSnapshotError fixability', () => {
  test('repo-side failures are agent-fixable', () => {
    expect(describeSnapshotError('dockerfile').fixableByAgent).toBe(true);
    expect(describeSnapshotError('git').fixableByAgent).toBe(true);
    expect(describeSnapshotError('unknown').fixableByAgent).toBe(true);
  });

  test('infra failures are not agent-fixable', () => {
    expect(describeSnapshotError('tunnel').fixableByAgent).toBe(false);
    expect(describeSnapshotError('provider').fixableByAgent).toBe(false);
    expect(describeSnapshotError('timeout').fixableByAgent).toBe(false);
    expect(describeSnapshotError('runtime').fixableByAgent).toBe(false);
  });

  test('classify + describe compose to a full descriptor', () => {
    const info = describeSnapshotError(classifySnapshotError('failed to solve: exit code: 1'));
    expect(info.category).toBe('dockerfile');
    expect(info.fixableByAgent).toBe(true);
    expect(info.title.length).toBeGreaterThan(0);
  });
});
