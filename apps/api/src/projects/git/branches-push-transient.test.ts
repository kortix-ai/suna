import { afterEach, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { commitMultipleFilesToBranch } from './branches';
import { classifyGitError, isTransientGitMirrorError, refreshMirror } from './mirror';
import type { GitBackedProject } from './types';

// Regression for KRTX-238 (Better Stack FE pattern `0cb9ab43…`, project
// Creating a connector during onboarding commits kortix.yaml through
// `commitMultipleFilesToBranch`. The push hit GitHub's transient
// `error: RPC failed; HTTP 404 curl 22 The requested URL returned error: 404`
// + `fatal: the remote end hung up unexpectedly`. Clone and fetch already retry
// that transient class; the push did not, so the one blip surfaced as a 502 to
// the browser and paged Sentry. This test drives the REAL commit path with a
// one-shot failing `pre-push` hook in the mirror: without the retry the commit
// rejects; with it the second attempt lands the commit.

const exec = promisify(execFile);
const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const PRODUCTION_PUSH_STDERR = [
  'error: RPC failed; HTTP 404 curl 22 The requested URL returned error: 404',
  'fatal: the remote end hung up unexpectedly',
].join('\n');

describe('transient classifier — the production KRTX-238 shape', () => {
  test('classifies the exact 404 RPC push failure as transient (retryable)', () => {
    const err = classifyGitError(
      { stderr: PRODUCTION_PUSH_STDERR, code: 128, message: 'Command failed: git push' },
      ['push', 'origin', 'abc:refs/heads/main'],
      30_000,
    );
    expect(err.kind).toBe('failed');
    expect(isTransientGitMirrorError(err)).toBe(true);
  });
});

async function git(args: string[]): Promise<string> {
  const { stdout } = await exec('git', args);
  return stdout.trim();
}

async function makeFixture(): Promise<{
  root: string;
  remote: string;
  project: GitBackedProject;
}> {
  const root = await mkdtemp(join(tmpdir(), 'kortix-push-retry-'));
  cleanupPaths.push(root);
  const seed = join(root, 'seed');
  const remote = join(root, 'remote.git');

  await git(['init', '--initial-branch=main', seed]);
  await git(['-C', seed, 'config', 'user.name', 'Kortix Test']);
  await git(['-C', seed, 'config', 'user.email', 'test@kortix.invalid']);
  await writeFile(join(seed, 'kortix.yaml'), 'kortix_version: 2\nconnectors: []\n');
  await git(['-C', seed, 'add', 'kortix.yaml']);
  await git(['-C', seed, 'commit', '-m', 'seed manifest']);
  await git(['init', '--bare', remote]);
  await git(['-C', seed, 'remote', 'add', 'origin', remote]);
  await git(['-C', seed, 'push', 'origin', 'main']);
  await git(['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main']);

  const cache = join(root, 'cache');
  process.env.KORTIX_GIT_CACHE_DIR = cache;

  const project: GitBackedProject = {
    projectId: `push-retry-${crypto.randomUUID()}`,
    repoUrl: remote,
    defaultBranch: 'main',
    manifestPath: 'kortix.yaml',
    gitAuthToken: 'local-test',
  };
  return { root, remote, project };
}

/**
 * Install a `pre-push` hook for `repoPath`. Git resolves hooks from
 * `core.hooksPath`, so point that at a dedicated `mkdtemp` directory rather than
 * writing into the mirror's own `hooks/` dir. The dedicated mkdtemp root is the
 * documented-safe location for a temp file (CodeQL js/insecure-temporary-file),
 * and it keeps the mirror a pure clone.
 */
async function installPrePushHook(repoPath: string, script: string): Promise<void> {
  const hooksDir = await mkdtemp(join(tmpdir(), 'kortix-push-hooks-'));
  cleanupPaths.push(hooksDir);
  const hookPath = join(hooksDir, 'pre-push');
  await writeFile(hookPath, script);
  await chmod(hookPath, 0o755);
  await git(['--git-dir', repoPath, 'config', 'core.hooksPath', hooksDir]);
}

describe('commit push — transient retry', () => {
  test('retries a transient RPC 404 push failure once and lands the commit', async () => {
    const { root, remote, project } = await makeFixture();
    const previousCacheDir = process.env.KORTIX_GIT_CACHE_DIR;

    try {
      // Warm the mirror so the failing hook is installed in the repo that
      // actually pushes.
      const repoPath = await refreshMirror(project, true);
      const marker = join(root, 'first-push-attempted');
      await installPrePushHook(
        repoPath,
        `#!/bin/sh\nif [ ! -f "${marker}" ]; then\n  touch "${marker}"\n  echo "error: RPC failed; HTTP 404 curl 22 The requested URL returned error: 404" >&2\n  echo "fatal: the remote end hung up unexpectedly" >&2\n  exit 1\nfi\nexit 0\n`,
      );

      const revision = await git(['--git-dir', remote, 'rev-parse', 'refs/heads/main:kortix.yaml']);

      const result = await commitMultipleFilesToBranch(project, {
        files: [
          {
            path: 'kortix.yaml',
            content: 'kortix_version: 2\nconnectors:\n  - slug: retry\n    provider: http\n',
          },
        ],
        message: 'add connector retry',
        expectedFileRevision: {
          path: 'kortix.yaml',
          sha: revision,
          candidatePaths: ['kortix.yaml', 'kortix.yml', 'kortix.toml'],
        },
      });

      expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);
      // The hook ran, so the first attempt really failed before the retry.
      expect(existsSync(marker)).toBe(true);
      expect(await git(['--git-dir', remote, 'show', 'main:kortix.yaml'])).toContain('slug: retry');
    } finally {
      if (previousCacheDir === undefined) delete process.env.KORTIX_GIT_CACHE_DIR;
      else process.env.KORTIX_GIT_CACHE_DIR = previousCacheDir;
    }
  });

  test('does not retry a permanent (non-transient) push failure', async () => {
    const { root, remote, project } = await makeFixture();
    const previousCacheDir = process.env.KORTIX_GIT_CACHE_DIR;

    try {
      const repoPath = await refreshMirror(project, true);
      const counter = join(root, 'push-attempts');
      await installPrePushHook(
        repoPath,
        `#!/bin/sh\necho x >> "${counter}"\necho "fatal: Authentication failed for 'https://github.com/x/y.git/'" >&2\nexit 1\n`,
      );

      const revision = await git(['--git-dir', remote, 'rev-parse', 'refs/heads/main:kortix.yaml']);

      await expect(
        commitMultipleFilesToBranch(project, {
          files: [{ path: 'kortix.yaml', content: 'kortix_version: 2\nconnectors: []\n' }],
          message: 'permanent failure',
          expectedFileRevision: {
            path: 'kortix.yaml',
            sha: revision,
            candidatePaths: ['kortix.yaml', 'kortix.yml', 'kortix.toml'],
          },
        }),
      ).rejects.toThrow(/Authentication failed/);

      const attempts = await Bun.file(counter)
        .text()
        .then((text) => text.trim().split('\n').length);
      expect(attempts).toBe(1);
    } finally {
      if (previousCacheDir === undefined) delete process.env.KORTIX_GIT_CACHE_DIR;
      else process.env.KORTIX_GIT_CACHE_DIR = previousCacheDir;
    }
  });
});
