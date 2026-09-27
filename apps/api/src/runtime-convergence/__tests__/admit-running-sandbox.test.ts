import { describe, expect, test } from 'bun:test';
import { admitRunningSandbox } from '../admit-running-sandbox';
import { managedLineupFingerprint } from '../catalog-fingerprint';
import { MIN_DAEMON_BUILD } from '../admission';
import type { GitBackedProject } from '../../projects/git/types';

const PROJECT: GitBackedProject = {
  projectId: 'proj_x',
  repoUrl: 'https://example.invalid/repo.git',
  defaultBranch: 'main',
  manifestPath: 'kortix.yaml',
  gitAuthToken: null,
};

const BASE_INPUT = {
  externalId: 'ext_1',
  userId: 'user_1',
  project: PROJECT,
  baseRef: 'main',
  sessionAgent: null,
  repositoryAccess: true,
  sessionId: 'session_1',
};

describe('admitRunningSandbox', () => {
  test('admits a box whose health proves every check', async () => {
    // The real, live fingerprint of this deployment's served managed lineup —
    // admitRunningSandbox composes `computeDesiredRuntime` for real (only the
    // health fetch and release resolution are faked), so the box must report
    // THIS value to be admitted.
    const verdict = await admitRunningSandbox(BASE_INPUT, {
      fetchHealth: async () => ({
        capabilities: ['config.release.v1'],
        runtime_truth: { daemon_build: MIN_DAEMON_BUILD + 1, catalog_fingerprint: managedLineupFingerprint() },
      }),
      resolveReleaseId: async () => 'rel_x',
    });
    expect(verdict.admitted).toBe(true);
  });

  test('a box that cannot be reached for health reports nothing and is refused, not admitted by default', async () => {
    const verdict = await admitRunningSandbox(BASE_INPUT, {
      fetchHealth: async () => null,
      resolveReleaseId: async () => 'rel_x',
    });
    expect(verdict.admitted).toBe(false);
  });

  test('never throws — a resolveReleaseId that throws is swallowed and the box is admitted rather than blocking session open', async () => {
    const verdict = await admitRunningSandbox(BASE_INPUT, {
      fetchHealth: async () => {
        throw new Error('boom');
      },
      resolveReleaseId: async () => {
        throw new Error('boom');
      },
    });
    expect(verdict.admitted).toBe(true);
  });
});
