import { afterEach, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { GitFileRevisionConflictError, commitMultipleFilesToBranch } from './branches';
import { refreshMirror } from './mirror';
import type { GitBackedProject } from './types';

// Characterization tests for the push-race recovery inside
// `commitMultipleFilesToBranch`: a push the remote rejects AFTER the remote
// already advanced to this very commit returns success, and a remote tip that
// differs from the parent sha throws the revision-conflict error. They pin the
// current behavior, so the commit-writer extraction must keep them green.
//
// A `pre-push` hook drives the race deterministically: it advances the remote
// itself (git runs the hook before the transfer, so the hook's own push is the
// concurrent writer), then fails the outer push with a permanent error so the
// writer enters its catch path with one single attempt.

const exec = promisify(execFile);
const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function git(args: string[]): Promise<string> {
  const { stdout } = await exec('git', args);
  return stdout.trim();
}

async function makeFixture(): Promise<{ root: string; remote: string; project: GitBackedProject }> {
  const root = await mkdtemp(join(tmpdir(), 'kortix-commit-race-'));
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

  process.env.KORTIX_GIT_CACHE_DIR = join(root, 'cache');

  const project: GitBackedProject = {
    projectId: `commit-race-${crypto.randomUUID()}`,
    repoUrl: remote,
    defaultBranch: 'main',
    manifestPath: 'kortix.yaml',
    gitAuthToken: 'local-test',
  };
  return { root, remote, project };
}

/** Install a `pre-push` hook for `repoPath` (see branches-push-transient.test.ts). */
async function installPrePushHook(repoPath: string, script: string): Promise<void> {
  const hooksDir = await mkdtemp(join(tmpdir(), 'kortix-race-hooks-'));
  cleanupPaths.push(hooksDir);
  const hookPath = join(hooksDir, 'pre-push');
  await writeFile(hookPath, script);
  await chmod(hookPath, 0o755);
  await git(['--git-dir', repoPath, 'config', 'core.hooksPath', hooksDir]);
}

const PERMANENT_PUSH_FAILURE = "fatal: Authentication failed for 'https://example.invalid/x/y.git/'";

describe('commitMultipleFilesToBranch push-race recovery', () => {
  test('returns success when the remote already moved to this commit', async () => {
    const { root, remote, project } = await makeFixture();
    const previousCacheDir = process.env.KORTIX_GIT_CACHE_DIR;

    try {
      const repoPath = await refreshMirror(project, true);
      const marker = join(root, 'race-first-attempt');
      const attempts = join(root, 'race-attempts');
      await installPrePushHook(
        repoPath,
        `#!/bin/sh\nread local_ref local_sha remote_ref remote_sha\necho x >> "${attempts}"\nif [ ! -f "${marker}" ]; then\n  touch "${marker}"\n  git --git-dir="${repoPath}" push --no-verify origin "${'$'}local_sha:refs/heads/main" >/dev/null 2>&1\n  echo "${PERMANENT_PUSH_FAILURE}" >&2\n  exit 1\nfi\nexit 0\n`,
      );

      const revision = await git(['--git-dir', remote, 'rev-parse', 'refs/heads/main:kortix.yaml']);
      const result = await commitMultipleFilesToBranch(project, {
        files: [{ path: 'kortix.yaml', content: 'kortix_version: 2\nconnectors: []\n' }],
        message: 'race to the same commit',
        expectedFileRevision: {
          path: 'kortix.yaml',
          sha: revision,
          candidatePaths: ['kortix.yaml', 'kortix.yml'],
        },
      });

      expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);
      expect(await git(['--git-dir', remote, 'rev-parse', 'refs/heads/main'])).toBe(result.commitSha);
      // One attempt: the permanent failure is not retried, so success came from
      // the race recovery and not from a retry that landed on a clear remote.
      expect(existsSync(marker)).toBe(true);
      expect((await Bun.file(attempts).text()).trim().split('\n').length).toBe(1);
    } finally {
      if (previousCacheDir === undefined) delete process.env.KORTIX_GIT_CACHE_DIR;
      else process.env.KORTIX_GIT_CACHE_DIR = previousCacheDir;
    }
  });

  test('throws the revision-conflict error when the remote tip moved to a different sha', async () => {
    const { root, remote, project } = await makeFixture();
    const previousCacheDir = process.env.KORTIX_GIT_CACHE_DIR;

    try {
      const repoPath = await refreshMirror(project, true);
      const parentSha = await git(['--git-dir', remote, 'rev-parse', 'refs/heads/main']);
      const marker = join(root, 'concurrent-first-attempt');
      await installPrePushHook(
        repoPath,
        `#!/bin/sh\necho x >> "${join(root, 'concurrent-attempts')}"\nif [ ! -f "${marker}" ]; then\n  touch "${marker}"\n  parent=$(git --git-dir="${repoPath}" rev-parse refs/heads/main)\n  tree=$(git --git-dir="${repoPath}" rev-parse "refs/heads/main^{tree}")\n  competing=$(GIT_AUTHOR_NAME=Concurrent GIT_AUTHOR_EMAIL=concurrent@example.invalid GIT_COMMITTER_NAME=Concurrent GIT_COMMITTER_EMAIL=concurrent@example.invalid git --git-dir="${repoPath}" commit-tree "${'$'}tree" -p "${'$'}parent" -m concurrent)\n  git --git-dir="${repoPath}" push --no-verify origin "${'$'}competing:refs/heads/main" >/dev/null 2>&1\n  echo "${PERMANENT_PUSH_FAILURE}" >&2\n  exit 1\nfi\nexit 0\n`,
      );

      const revision = await git(['--git-dir', remote, 'rev-parse', 'refs/heads/main:kortix.yaml']);
      await expect(
        commitMultipleFilesToBranch(project, {
          files: [{ path: 'kortix.yaml', content: 'kortix_version: 2\nconnectors: []\n' }],
          message: 'concurrent remote edit',
          expectedFileRevision: {
            path: 'kortix.yaml',
            sha: revision,
            candidatePaths: ['kortix.yaml', 'kortix.yml'],
          },
        }),
      ).rejects.toThrow(GitFileRevisionConflictError);

      const remoteTip = await git(['--git-dir', remote, 'rev-parse', 'refs/heads/main']);
      expect(remoteTip).not.toBe(parentSha);
      expect(existsSync(marker)).toBe(true);
    } finally {
      if (previousCacheDir === undefined) delete process.env.KORTIX_GIT_CACHE_DIR;
      else process.env.KORTIX_GIT_CACHE_DIR = previousCacheDir;
    }
  });
});
