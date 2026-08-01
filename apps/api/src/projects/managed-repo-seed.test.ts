import { describe, expect, test } from 'bun:test';
import {
  ManagedRepoSeedError,
  buildManagedRepoSeedState,
  isMissingRemoteBranchError,
  pushVerifiedSeed,
  readManagedRepoSeedState,
  shouldSelfHealManagedRepoSeed,
} from './managed-repo-seed';

const PROJECT_ID = '514f25cd-1c15-4104-8d2b-0aae00c949f6';

function captureErrorLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '));
  };
  return {
    lines,
    restore: () => {
      console.error = original;
    },
  };
}

describe('pushVerifiedSeed', () => {
  test('resolves when the default branch exists after the push', async () => {
    const calls: string[] = [];
    await pushVerifiedSeed({
      projectId: PROJECT_ID,
      branch: 'main',
      push: async () => {
        calls.push('push');
      },
      remoteHasBranch: async () => {
        calls.push('verify');
        return true;
      },
    });
    expect(calls).toEqual(['push', 'verify']);
  });

  test('rejects when the push reports success but the default branch is still missing', async () => {
    const log = captureErrorLogs();
    try {
      const promise = pushVerifiedSeed({
        projectId: PROJECT_ID,
        branch: 'main',
        push: async () => {},
        remoteHasBranch: async () => false,
      });
      await expect(promise).rejects.toThrow(ManagedRepoSeedError);
    } finally {
      log.restore();
    }
  });

  test('names the project id, the branch and the verify stage in the failure', async () => {
    const log = captureErrorLogs();
    let caught: unknown;
    try {
      await pushVerifiedSeed({
        projectId: PROJECT_ID,
        branch: 'trunk',
        push: async () => {},
        remoteHasBranch: async () => false,
      });
    } catch (error) {
      caught = error;
    } finally {
      log.restore();
    }
    expect(caught).toBeInstanceOf(ManagedRepoSeedError);
    const error = caught as ManagedRepoSeedError;
    expect(error.projectId).toBe(PROJECT_ID);
    expect(error.stage).toBe('verify');
    expect(error.message).toContain(PROJECT_ID);
    expect(error.message).toContain('trunk');
  });

  test('logs the swallowed-until-now verification failure with the project id', async () => {
    const log = captureErrorLogs();
    try {
      await pushVerifiedSeed({
        projectId: PROJECT_ID,
        branch: 'main',
        push: async () => {},
        remoteHasBranch: async () => false,
      }).catch(() => {});
    } finally {
      log.restore();
    }
    expect(log.lines.some((line) => line.includes(PROJECT_ID))).toBe(true);
    expect(log.lines.some((line) => line.includes('[managed-repo-seed]'))).toBe(true);
  });

  test('retries the push once, bounded, when the branch is still missing', async () => {
    let pushes = 0;
    await pushVerifiedSeed({
      projectId: PROJECT_ID,
      branch: 'main',
      push: async () => {
        pushes += 1;
      },
      remoteHasBranch: async () => pushes >= 2,
    });
    expect(pushes).toBe(2);
  });

  test('stops after the attempt bound instead of pushing forever', async () => {
    let pushes = 0;
    const log = captureErrorLogs();
    try {
      await pushVerifiedSeed({
        projectId: PROJECT_ID,
        branch: 'main',
        push: async () => {
          pushes += 1;
        },
        remoteHasBranch: async () => false,
      }).catch(() => {});
    } finally {
      log.restore();
    }
    expect(pushes).toBe(2);
  });

  test('surfaces a push failure as a push-stage error carrying the git detail', async () => {
    const log = captureErrorLogs();
    let caught: unknown;
    try {
      await pushVerifiedSeed({
        projectId: PROJECT_ID,
        branch: 'main',
        push: async () => {
          throw new Error('commit to repo#main failed: 503');
        },
        remoteHasBranch: async () => false,
      });
    } catch (error) {
      caught = error;
    } finally {
      log.restore();
    }
    expect((caught as ManagedRepoSeedError).stage).toBe('push');
    expect((caught as ManagedRepoSeedError).message).toContain('503');
  });

  test('fails closed when the verification check itself cannot answer', async () => {
    const log = captureErrorLogs();
    let caught: unknown;
    try {
      await pushVerifiedSeed({
        projectId: PROJECT_ID,
        branch: 'main',
        push: async () => {},
        remoteHasBranch: async () => {
          throw new Error('ls-remote timed out');
        },
      });
    } catch (error) {
      caught = error;
    } finally {
      log.restore();
    }
    expect((caught as ManagedRepoSeedError).stage).toBe('verify');
    expect((caught as ManagedRepoSeedError).message).toContain('ls-remote timed out');
  });
});

describe('managed repo seed state', () => {
  test('records a completed seed', () => {
    const state = buildManagedRepoSeedState({
      seeded: true,
      expected: true,
      reason: 'seeded',
      at: '2026-07-30T00:00:00.000Z',
    });
    expect(state).toEqual({
      seeded: true,
      expected: true,
      reason: 'seeded',
      at: '2026-07-30T00:00:00.000Z',
    });
  });

  test('records an explicit caller opt-out as expected false', () => {
    const state = buildManagedRepoSeedState({
      seeded: false,
      expected: false,
      reason: 'caller_opted_out',
      at: '2026-07-30T00:00:00.000Z',
    });
    expect(state.seeded).toBe(false);
    expect(state.expected).toBe(false);
    expect(state.reason).toBe('caller_opted_out');
  });

  test('reads the state back off project metadata', () => {
    const metadata = {
      git: {
        managed: true,
        seed: {
          seeded: false,
          expected: false,
          reason: 'caller_opted_out',
          at: '2026-07-30T00:00:00.000Z',
        },
      },
    };
    expect(readManagedRepoSeedState(metadata)).toEqual({
      seeded: false,
      expected: false,
      reason: 'caller_opted_out',
      at: '2026-07-30T00:00:00.000Z',
    });
  });

  test('returns null for a project that predates seed-state recording', () => {
    expect(readManagedRepoSeedState({ git: { managed: true } })).toBeNull();
    expect(readManagedRepoSeedState(null)).toBeNull();
    expect(readManagedRepoSeedState({ git: { seed: 'yes' } })).toBeNull();
  });
});

describe('isMissingRemoteBranchError', () => {
  test('recognises the fetch failure a structurally empty repo produces', () => {
    expect(
      isMissingRemoteBranchError(new Error("fatal: couldn't find remote ref refs/heads/main")),
    ).toBe(true);
  });

  test('recognises the rev-parse failure that follows it', () => {
    expect(isMissingRemoteBranchError(new Error('fatal: Needed a single revision'))).toBe(true);
  });

  test('does not treat a local pathspec miss as a missing remote branch', () => {
    expect(
      isMissingRemoteBranchError(
        new Error("error: pathspec 'main' did not match any file(s) known to git"),
      ),
    ).toBe(false);
  });

  test('does not swallow an auth failure as a missing branch', () => {
    expect(
      isMissingRemoteBranchError(
        new Error('fatal: could not read Username for https://github.com'),
      ),
    ).toBe(false);
  });

  test('does not swallow a timeout as a missing branch', () => {
    expect(isMissingRemoteBranchError(new Error('git fetch timed out after 30000ms'))).toBe(false);
  });

  test('is false for a non-error value', () => {
    expect(isMissingRemoteBranchError(null)).toBe(false);
    expect(isMissingRemoteBranchError('main missing')).toBe(false);
  });

  test('reads the stderr of a GitOperationError-shaped rejection', () => {
    const err = Object.assign(new Error('git fetch failed'), {
      stderr: "fatal: couldn't find remote ref refs/heads/main\n",
    });
    expect(isMissingRemoteBranchError(err)).toBe(true);
  });
});

describe('shouldSelfHealManagedRepoSeed', () => {
  test('repairs a managed repo that has no recorded seed state', () => {
    expect(
      shouldSelfHealManagedRepoSeed({ managed: true, metadata: { git: { managed: true } } }),
    ).toBe(true);
  });

  test('repairs a managed repo whose seed was expected but never landed', () => {
    const metadata = {
      git: {
        managed: true,
        seed: {
          seeded: false,
          expected: true,
          reason: 'push_failed',
          at: '2026-07-30T00:00:00.000Z',
        },
      },
    };
    expect(shouldSelfHealManagedRepoSeed({ managed: true, metadata })).toBe(true);
  });

  test('leaves an explicit caller opt-out alone so kortix ship can push its own history', () => {
    const metadata = {
      git: {
        managed: true,
        seed: {
          seeded: false,
          expected: false,
          reason: 'caller_opted_out',
          at: '2026-07-30T00:00:00.000Z',
        },
      },
    };
    expect(shouldSelfHealManagedRepoSeed({ managed: true, metadata })).toBe(false);
  });

  test('never touches a repo Kortix does not manage', () => {
    expect(shouldSelfHealManagedRepoSeed({ managed: false, metadata: null })).toBe(false);
  });
});
