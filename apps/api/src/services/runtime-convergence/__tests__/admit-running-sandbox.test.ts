import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { logger } from '../../../lib/logger';
import { admitRunningSandbox } from '../admit-running-sandbox';
import { managedLineupFingerprint } from '../catalog-fingerprint';
import { MIN_DAEMON_BUILD } from '../admission';
import type { GitBackedProject } from '../../git/types';

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
  const originalEnforce = process.env.RUNTIME_ADMISSION_ENFORCE;
  afterEach(() => {
    if (originalEnforce === undefined) delete process.env.RUNTIME_ADMISSION_ENFORCE;
    else process.env.RUNTIME_ADMISSION_ENFORCE = originalEnforce;
  });

  test('reports observe-only refusal as a warning and enforced refusal as an error', async () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => {});
    const error = spyOn(logger, 'error').mockImplementation(() => {});
    const deps = { fetchHealth: async () => ({ capabilities: [] }), resolveReleaseId: async () => null };
    try {
      process.env.RUNTIME_ADMISSION_ENFORCE = 'false';
      expect((await admitRunningSandbox(BASE_INPUT, deps)).admitted).toBe(false);
      expect(warn).toHaveBeenCalledWith(
        '[runtime-convergence] admission refused — observe only, box still used',
        expect.objectContaining({ failed_check: 'config_release_capability' }),
      );
      expect(error).not.toHaveBeenCalled();

      process.env.RUNTIME_ADMISSION_ENFORCE = 'true';
      expect((await admitRunningSandbox(BASE_INPUT, deps)).admitted).toBe(false);
      expect(error).toHaveBeenCalledWith(
        '[runtime-convergence] admission refused — box replaced, not used',
        expect.objectContaining({ failed_check: 'config_release_capability' }),
      );
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

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
