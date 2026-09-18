import { describe, expect, test } from 'bun:test';
import {
  convergeSessionConfig,
  type SessionConfigConvergenceDeps,
} from '../session-config-convergence';
import { configNeedsPush, type SessionReloadResult } from '../session-reload';

const TARGET = {
  projectId: 'proj-1',
  accountId: 'acct-1',
  sessionId: 'sess-1',
  repoUrl: 'https://git.example/proj-1.git',
  defaultBranch: 'main',
  manifestPath: 'kortix.yaml',
  baseRef: 'main',
};

function result(overrides: Partial<SessionReloadResult> = {}): SessionReloadResult {
  return {
    applied: true,
    previous_etag: 'aaaa',
    etag: 'bbbb',
    repo_refreshed: true,
    commit_sha: null,
    agent_files: 'updated',
    opencode_reload: 'restarted',
    turn_ended: false,
    ...overrides,
  };
}

function deps(results: SessionReloadResult[], overrides: Partial<SessionConfigConvergenceDeps> = {}) {
  const reloads: Parameters<SessionConfigConvergenceDeps['reload']>[0][] = [];
  const sleeps: number[] = [];
  const queue = [...results];
  const built: SessionConfigConvergenceDeps = {
    loadTarget: async () => TARGET,
    reload: async (input) => {
      reloads.push(input);
      const next = queue.shift();
      if (!next) throw new Error('reload called more often than the test scripted');
      return next;
    },
    // Never actually wait in a test; just record the schedule.
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...overrides,
  };
  return { deps: built, reloads, sleeps };
}

describe('convergeSessionConfig', () => {
  test('reloads a woken session, only if stale, and never by force', async () => {
    const d = deps([result()]);

    expect(await convergeSessionConfig('sess-1', d.deps)).toBe('converged');

    expect(d.reloads.length).toBe(1);
    expect(d.reloads[0]).toMatchObject({ ...TARGET, onlyIfStale: true, force: false });
  });

  test('a box that is already current costs one call and no restart', async () => {
    const d = deps([
      result({ applied: false, agent_files: 'already-current', reason: 'already current' }),
    ]);

    expect(await convergeSessionConfig('sess-1', d.deps)).toBe('current');
    expect(d.reloads.length).toBe(1);
    expect(d.sleeps).toEqual([]);
  });

  test('retries soon while the guest daemon is still binding its port', async () => {
    const unreachable = result({ applied: false, agent_files: 'unknown', reason: 'no reachable sandbox' });
    const d = deps([unreachable, unreachable, result()]);

    expect(await convergeSessionConfig('sess-1', d.deps)).toBe('converged');
    expect(d.sleeps).toEqual([5_000, 10_000]);
  });

  test('waits out a running turn instead of ending it', async () => {
    const busy = result({ applied: false, agent_files: 'unknown', reason: 'session is mid-turn' });
    const d = deps([busy, result()]);

    expect(await convergeSessionConfig('sess-1', d.deps)).toBe('converged');
    // Minutes, not seconds: a turn is not over in five.
    expect(d.sleeps.length).toBe(1);
    expect(d.sleeps[0]).toBeGreaterThanOrEqual(5 * 60_000);
    expect(d.reloads.every((input) => input.force === false)).toBe(true);
  });

  test('"could not confirm idle" counts as busy', async () => {
    const unsure = result({
      applied: false,
      agent_files: 'unknown',
      reason: 'could not confirm the session is idle',
    });
    const d = deps([unsure, result()]);

    expect(await convergeSessionConfig('sess-1', d.deps)).toBe('converged');
    expect(d.sleeps[0]).toBeGreaterThanOrEqual(5 * 60_000);
  });

  test('retries a refused file sync once the daemon has had time to self-update', async () => {
    // A box imported before the ownership fix runs a daemon that refuses with
    // `local changes` on the platform's own files. Its replacement is staged on
    // this same wake and swaps in after ~5 min of idle uptime.
    const refused = result({ agent_files: 'kept-yours' });
    const d = deps([refused, result()]);

    expect(await convergeSessionConfig('sess-1', d.deps)).toBe('converged');
    expect(d.sleeps[0]).toBeGreaterThanOrEqual(5 * 60_000);
  });

  test('a session that really edited its agent is left alone after the retries', async () => {
    const refused = result({ agent_files: 'kept-yours' });
    const d = deps([refused, refused, refused]);

    expect(await convergeSessionConfig('sess-1', d.deps)).toBe('kept-session-edits');
    expect(d.reloads.length).toBe(3);
  });

  test('gives up on a box that never answers, bounded', async () => {
    const unreachable = result({ applied: false, agent_files: 'unknown', reason: 'no reachable sandbox' });
    const d = deps(Array.from({ length: 12 }, () => unreachable));

    expect(await convergeSessionConfig('sess-1', d.deps)).toBe('unreachable');
    expect(d.reloads.length).toBeLessThanOrEqual(6);
  });

  test('a session with no project row is skipped, not thrown', async () => {
    const d = deps([], { loadTarget: async () => null });

    expect(await convergeSessionConfig('sess-1', d.deps)).toBe('no-session');
    expect(d.reloads.length).toBe(0);
  });

  test('never throws — the wake it rides on is already reported ready', async () => {
    const d = deps([], {
      reload: async () => {
        throw new Error('mirror unreachable');
      },
    });

    expect(await convergeSessionConfig('sess-1', d.deps)).toBe('failed');
  });
});

describe('configNeedsPush', () => {
  test('files that were brought forward always need the restart that reads them', () => {
    expect(configNeedsPush({ agentFiles: 'updated', runningEtag: 'a', latestEtag: 'a' })).toBe(true);
  });

  test('a moved etag needs a push even when the files were kept', () => {
    // Governance — connectors, secrets, scope — lives in the compiled config.
    expect(configNeedsPush({ agentFiles: 'kept-yours', runningEtag: 'a', latestEtag: 'b' })).toBe(true);
    expect(configNeedsPush({ agentFiles: 'already-current', runningEtag: 'a', latestEtag: 'b' })).toBe(true);
  });

  test('a current box is NOT restarted', () => {
    for (const agentFiles of ['already-current', 'not-applicable', 'kept-yours', 'unknown'] as const) {
      expect(configNeedsPush({ agentFiles, runningEtag: 'a', latestEtag: 'a' })).toBe(false);
    }
  });

  test('an unknown etag is not permission to restart a runtime unasked', () => {
    expect(configNeedsPush({ agentFiles: 'already-current', runningEtag: null, latestEtag: 'b' })).toBe(false);
    expect(configNeedsPush({ agentFiles: 'already-current', runningEtag: 'a', latestEtag: null })).toBe(false);
  });
});
