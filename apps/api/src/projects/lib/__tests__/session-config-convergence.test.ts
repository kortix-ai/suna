import { describe, expect, test } from 'bun:test';
import {
  convergeSessionConfig,
  type SessionConfigConvergenceDeps,
} from '../session-config-convergence';
import {
  combineConfigStaleness,
  configNeedsPush,
  type SessionReloadResult,
} from '../session-reload';

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

  test('"could not confirm idle" right after a wake is retried in SECONDS', async () => {
    // Preview, 2026-09-18: 1 s after a wake opencode was not answering yet, so
    // the reload could not confirm idle; by +9 s it could. Filed under "busy",
    // that cost a 6-minute wait and the session ran stale config for 371 s.
    const unsure = result({
      applied: false,
      agent_files: 'unknown',
      reason: 'could not confirm the session is idle',
    });
    const d = deps([unsure, result()]);

    expect(await convergeSessionConfig('sess-1', d.deps)).toBe('converged');
    expect(d.sleeps).toEqual([5_000]);
  });

  test('a transient answer that persists escalates to minutes instead of giving up', async () => {
    const unsure = result({
      applied: false,
      agent_files: 'unknown',
      reason: 'could not confirm the session is idle',
    });
    const d = deps([unsure, unsure, unsure, unsure, unsure, result()]);

    expect(await convergeSessionConfig('sess-1', d.deps)).toBe('converged');
    expect(d.sleeps).toEqual([5_000, 10_000, 15_000, 30_000, 6 * 60_000]);
  });

  test('a box with a pre-fix daemon converges right after the swap its own retry triggers', async () => {
    // Attempt 1: the old daemon refuses with `local changes` on the platform's
    // own files. +6 min: still the old daemon, but this call's refresh opens the
    // swap. +60 s: the new daemon answers.
    const refused = result({ agent_files: 'kept-yours' });
    const d = deps([refused, refused, result()]);

    expect(await convergeSessionConfig('sess-1', d.deps)).toBe('converged');
    expect(d.sleeps).toEqual([6 * 60_000, 60_000]);
  });

  test('a session that really edited its agent is left alone after the retries', async () => {
    const refused = result({ agent_files: 'kept-yours' });
    const d = deps([refused, refused, refused, refused]);

    expect(await convergeSessionConfig('sess-1', d.deps)).toBe('kept-session-edits');
    expect(d.reloads.length).toBe(4);
    expect(d.reloads.every((input) => input.force === false)).toBe(true);
  });

  test('gives up on a box that never answers, bounded', async () => {
    const unreachable = result({ applied: false, agent_files: 'unknown', reason: 'no reachable sandbox' });
    const d = deps(Array.from({ length: 12 }, () => unreachable));

    expect(await convergeSessionConfig('sess-1', d.deps)).toBe('unreachable');
    // 1 + four quick retries + three slow ones.
    expect(d.reloads.length).toBe(8);
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

describe('convergeSessionConfig with config releases', () => {
  const release = (outcome: SessionReloadResult['release_outcome'], overrides: Partial<SessionReloadResult> = {}) =>
    result({ config_path: 'release', release_outcome: outcome, ...overrides });

  test('applied is converged, unchanged is current, both in one call', async () => {
    for (const [outcome, expected] of [
      ['applied', 'converged'],
      ['unchanged', 'current'],
    ] as const) {
      const d = deps([release(outcome)]);
      expect(await convergeSessionConfig('sess-1', d.deps)).toBe(expected);
      expect(d.sleeps).toEqual([]);
    }
  });

  test('session-files is kept-session-edits and is not retried', async () => {
    const d = deps([release('session-files', { agent_files: 'kept-yours' })]);
    expect(await convergeSessionConfig('sess-1', d.deps)).toBe('kept-session-edits');
    expect(d.reloads.length).toBe(1);
  });

  test('declined and quarantined never loop', async () => {
    for (const outcome of ['declined', 'quarantined'] as const) {
      const d = deps([release(outcome, { applied: false, agent_files: 'unknown' })]);
      expect(await convergeSessionConfig('sess-1', d.deps)).toBe('declined');
      expect(d.reloads.length).toBe(1);
      expect(d.sleeps).toEqual([]);
    }
  });

  test('failed retries on the slow clock only', async () => {
    const failed = release('failed', { applied: false, agent_files: 'unknown' });
    const d = deps([failed, failed, failed, failed]);
    expect(await convergeSessionConfig('sess-1', d.deps)).toBe('failed');
    expect(d.sleeps).toEqual([6 * 60_000, 60_000, 20 * 60_000]);
  });

  test('a converge call without an answer is retried in seconds', async () => {
    const d = deps([release(null, { applied: false, agent_files: 'unknown' }), release('applied')]);
    expect(await convergeSessionConfig('sess-1', d.deps)).toBe('converged');
    expect(d.sleeps).toEqual([5_000]);
  });

  test('an old daemon is retried at 6 and 7 minutes, where its self-update lands', async () => {
    const legacy = result({ config_path: 'legacy', agent_files: 'unknown' });
    const d = deps([legacy, legacy, release('applied')]);
    expect(await convergeSessionConfig('sess-1', d.deps)).toBe('converged');
    expect(d.sleeps).toEqual([6 * 60_000, 60_000]);
  });

  test('an old daemon that never updates ends as awaiting-daemon-update, bounded', async () => {
    const legacy = result({ config_path: 'legacy', agent_files: 'unknown' });
    const d = deps([legacy, legacy, legacy, legacy]);
    expect(await convergeSessionConfig('sess-1', d.deps)).toBe('awaiting-daemon-update');
    expect(d.reloads.length).toBe(4);
  });
});

describe('convergeSessionConfig for a previous-repository session', () => {
  test('ends at once with previous-repository on every schedule', async () => {
    for (const schedule of ['wake', 'trigger'] as const) {
      const d = deps([result({ applied: false, agent_files: 'unknown', reason: 'session belongs to a previous repository' })]);
      expect(await convergeSessionConfig('sess-1', d.deps, { schedule })).toBe('previous-repository');
      expect(d.reloads.length).toBe(1);
      expect(d.sleeps).toEqual([]);
    }
  });
});

describe('convergeSessionConfig on the trigger schedule', () => {
  test('a busy session ends the attempt at once; the next turn end tries again', async () => {
    const busy = result({ applied: false, agent_files: 'unknown', reason: 'session is mid-turn' });
    const d = deps([busy]);
    expect(await convergeSessionConfig('sess-1', d.deps, { schedule: 'trigger' })).toBe('busy');
    expect(d.sleeps).toEqual([]);
  });

  test('an old daemon is one attempt, not the 27-minute ladder', async () => {
    const d = deps([result({ config_path: 'legacy', agent_files: 'unknown' })]);
    expect(await convergeSessionConfig('sess-1', d.deps, { schedule: 'trigger' })).toBe('awaiting-daemon-update');
    expect(d.reloads.length).toBe(1);
  });

  test('a box that is not answering yet still gets the quick ladder, and no slow one', async () => {
    const unreachable = result({ applied: false, agent_files: 'unknown', reason: 'no reachable sandbox' });
    const d = deps(Array.from({ length: 8 }, () => unreachable));
    expect(await convergeSessionConfig('sess-1', d.deps, { schedule: 'trigger' })).toBe('unreachable');
    expect(d.sleeps).toEqual([5_000, 10_000, 15_000, 30_000]);
  });

  test('refreshRepo false reaches the reload', async () => {
    const d = deps([result({ config_path: 'release', release_outcome: 'unchanged' })]);
    await convergeSessionConfig('sess-1', d.deps, { schedule: 'trigger', refreshRepo: false });
    expect(d.reloads[0]).toMatchObject({ refreshRepo: false, onlyIfStale: true, force: false });
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

describe('combineConfigStaleness', () => {
  test('either half alone makes the session stale', () => {
    expect(combineConfigStaleness(true, false)).toBe(true);
    // The case the etag misses: a merge that touched only a skill body.
    expect(combineConfigStaleness(false, true)).toBe(true);
    expect(combineConfigStaleness(null, true)).toBe(true);
  });

  test('both current is current', () => {
    expect(combineConfigStaleness(false, false)).toBe(false);
  });

  test('a daemon that cannot report its config dir keeps the etag verdict', () => {
    expect(combineConfigStaleness(false, null)).toBe(false);
    expect(combineConfigStaleness(true, null)).toBe(true);
  });

  test('an unknown etag is NEVER reported as up to date', () => {
    expect(combineConfigStaleness(null, false)).toBeNull();
    expect(combineConfigStaleness(null, null)).toBeNull();
  });
});
