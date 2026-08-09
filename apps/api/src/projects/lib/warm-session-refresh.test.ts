import { describe, expect, test } from 'bun:test';
import { prepareReusedWarmSession } from './warm-session-refresh';

const project = {
  projectId: 'project-1',
  repoUrl: 'https://git.example.test/project-1.git',
  defaultBranch: 'main',
  manifestPath: 'kortix.yaml',
};

const workspace = {
  status: 'updated' as const,
  before_sha: 'before',
  after_sha: 'after',
};

describe('prepareReusedWarmSession', () => {
  test('updates the compiled config after refreshing a reused workspace', async () => {
    const calls: string[] = [];
    const result = await prepareReusedWarmSession(
      { project, accountId: 'account-1', sessionId: 'session-1' },
      {
        refreshWorkspace: async () => {
          calls.push('workspace');
          return workspace;
        },
        readRunningConfig: async () => {
          calls.push('running');
          return { etag: 'old', reachable: true };
        },
        readLatestConfig: async () => {
          calls.push('latest');
          return 'new';
        },
        pushConfig: async () => {
          calls.push('push');
          return { applied: true };
        },
      },
    );

    expect(calls[0]).toBe('workspace');
    expect(new Set(calls.slice(1, 3))).toEqual(new Set(['running', 'latest']));
    expect(calls[3]).toBe('push');
    expect(result).toEqual({
      workspace,
      config: { status: 'updated', previous_etag: 'old', latest_etag: 'new' },
    });
  });

  test('does not restart a warm runtime that already has the current config', async () => {
    let pushed = false;
    const result = await prepareReusedWarmSession(
      { project, accountId: 'account-1', sessionId: 'session-1' },
      {
        refreshWorkspace: async () => ({ status: 'unchanged' }),
        readRunningConfig: async () => ({ etag: 'same', reachable: true }),
        readLatestConfig: async () => 'same',
        pushConfig: async () => {
          pushed = true;
          return { applied: true };
        },
      },
    );

    expect(pushed).toBe(false);
    expect(result.config).toEqual({
      status: 'current',
      previous_etag: 'same',
      latest_etag: 'same',
    });
  });

  test('updates a legacy warm runtime that cannot report its running etag', async () => {
    let pushed = false;
    const result = await prepareReusedWarmSession(
      { project, accountId: 'account-1', sessionId: 'session-1' },
      {
        refreshWorkspace: async () => ({ status: 'unchanged' }),
        readRunningConfig: async () => ({ etag: null, reachable: true }),
        readLatestConfig: async () => 'latest',
        pushConfig: async () => {
          pushed = true;
          return { applied: true };
        },
      },
    );

    expect(pushed).toBe(true);
    expect(result.config.status).toBe('updated');
  });

  test('does not report a problem while a warm runtime is still provisioning', async () => {
    let pushed = false;
    const result = await prepareReusedWarmSession(
      { project, accountId: 'account-1', sessionId: 'session-1' },
      {
        refreshWorkspace: async () => ({ status: 'skipped' }),
        readRunningConfig: async () => ({ etag: null, reachable: false }),
        readLatestConfig: async () => 'latest',
        pushConfig: async () => {
          pushed = true;
          return { applied: true };
        },
      },
    );

    expect(pushed).toBe(false);
    expect(result.config).toEqual({ status: 'unavailable' });
  });

  test('does not push anything when the project has no compiled config', async () => {
    let pushed = false;
    const result = await prepareReusedWarmSession(
      { project, accountId: 'account-1', sessionId: 'session-1' },
      {
        refreshWorkspace: async () => ({ status: 'unchanged' }),
        readRunningConfig: async () => ({ etag: null, reachable: true }),
        readLatestConfig: async () => null,
        pushConfig: async () => {
          pushed = true;
          return { applied: true };
        },
      },
    );

    expect(pushed).toBe(false);
    expect(result.config).toEqual({ status: 'not-applicable' });
  });

  test('reports a failed config push without hiding the workspace result', async () => {
    const result = await prepareReusedWarmSession(
      { project, accountId: 'account-1', sessionId: 'session-1' },
      {
        refreshWorkspace: async () => workspace,
        readRunningConfig: async () => ({ etag: 'old', reachable: true }),
        readLatestConfig: async () => 'new',
        pushConfig: async () => ({
          applied: false,
          reason: 'runtime unavailable',
        }),
      },
    );

    expect(result).toEqual({
      workspace,
      config: { status: 'failed', reason: 'runtime unavailable' },
    });
  });
});
