import { afterEach, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { GitFileRevisionConflictError, commitMultipleFilesToBranch } from './branches';
import { refreshMirror } from './mirror';
import type { GitBackedProject } from './types';

// Characterization tests for the push-race recovery in
// commitMultipleFilesToBranch: the catch after the push classifies WHY the
// push failed by reading the remote tip back.
//
//   - the remote already carries OUR commit  -> report success;
//   - the remote tip moved to someone else's -> typed revision conflict.
//
// Both drive the REAL commit path with real git: a `pre-push` hook in the
// mirror moves the remote ref (or lands a competing commit) before the push
// transport fails, which is exactly the interleaving the recovery exists for.

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

async function makeFixture(): Promise<{
  root: string;
  seed: string;
  remote: string;
  project: GitBackedProject;
}> {
  const root = await mkdtemp(join(tmpdir(), 'kortix-push-recovery-'));
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
    projectId: `push-recovery-${crypto.randomUUID()}`,
    repoUrl: remote,
    defaultBranch: 'main',
    manifestPath: 'kortix.yaml',
    gitAuthToken: 'local-test',
  };
  return { root, seed, remote, project };
}

/**
 * Install a `pre-push` hook for `repoPath` (see installPrePushHook in
 * branches-push-transient.test.ts for the core.hooksPath rationale). The hook
 * unsets the GIT_* repo-selection variables first: it invokes git against
 * OTHER repositories (the bare remote, the seed worktree), and git exports
 * GIT_DIR for hooks.
 */
async function installPrePushHook(repoPath: string, script: string): Promise<void> {
  const hooksDir = await mkdtemp(join(tmpdir(), 'kortix-push-recovery-hooks-'));
  cleanupPaths.push(hooksDir);
  const hookPath = join(hooksDir, 'pre-push');
  await writeFile(hookPath, `#!/bin/sh\nunset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE\n${script}`);
  await chmod(hookPath, 0o755);
  await git(['--git-dir', repoPath, 'config', 'core.hooksPath', hooksDir]);
}

describe('commit push — race recovery', () => {
  test('reports success when the push fails after the remote already carries the commit', async () => {
    const { remote, project } = await makeFixture();
    const previousCacheDir = process.env.KORTIX_GIT_CACHE_DIR;

    try {
      const repoPath = await refreshMirror(project, true);
      // The remote receives the commit (the hook transfers the objects from
      // the mirror — the failed transport never sent them — then applies the
      // ref), then the push transport still reports the RPC-404 failure.
      await git(['--git-dir', repoPath, 'config', 'uploadpack.allowAnySHA1InWant', 'true']);
      await installPrePushHook(
        repoPath,
        `read local_ref local_sha remote_ref remote_sha
git --git-dir "${remote}" fetch "${repoPath}" "$local_sha"
git --git-dir "${remote}" update-ref "$remote_ref" "$local_sha"
echo "error: RPC failed; HTTP 404 curl 22 The requested URL returned error: 404" >&2
echo "fatal: the remote end hung up unexpectedly" >&2
exit 1
`,
      );

      const revision = await git(['--git-dir', remote, 'rev-parse', 'refs/heads/main:kortix.yaml']);

      const result = await commitMultipleFilesToBranch(project, {
        files: [
          {
            path: 'kortix.yaml',
            content: 'kortix_version: 2\nconnectors:\n  - slug: recovery\n    provider: http\n',
          },
        ],
        message: 'add connector recovery',
        expectedFileRevision: {
          path: 'kortix.yaml',
          sha: revision,
          candidatePaths: ['kortix.yaml', 'kortix.yml', 'kortix.toml'],
        },
      });

      expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);
      expect(await git(['--git-dir', remote, 'show', 'main:kortix.yaml'])).toContain(
        'slug: recovery',
      );
    } finally {
      if (previousCacheDir === undefined) delete process.env.KORTIX_GIT_CACHE_DIR;
      else process.env.KORTIX_GIT_CACHE_DIR = previousCacheDir;
    }
  });

  test('throws the revision conflict when the remote tip moved to another commit', async () => {
    const { seed, remote, project } = await makeFixture();
    const previousCacheDir = process.env.KORTIX_GIT_CACHE_DIR;

    try {
      // Warm the mirror at the base tip BEFORE the competing commit exists
      // anywhere but the seed: the writer's parentSha must be the stale tip.
      const repoPath = await refreshMirror(project, true);
      await writeFile(join(seed, 'README.md'), '# competing\n');
      await git(['-C', seed, 'add', 'README.md']);
      await git(['-C', seed, 'commit', '-m', 'competing commit']);

      // The competing commit lands on the remote mid-push, then the push
      // itself fails permanently (auth denial — no transient retry).
      await installPrePushHook(
        repoPath,
        `git -C "${seed}" push origin main
echo "fatal: Authentication failed for 'https://github.com/x/y.git/'" >&2
exit 1
`,
      );

      const revision = await git(['--git-dir', remote, 'rev-parse', 'refs/heads/main:kortix.yaml']);

      await expect(
        commitMultipleFilesToBranch(project, {
          files: [{ path: 'kortix.yaml', content: 'kortix_version: 2\nconnectors: []\n' }],
          message: 'loses the race',
          expectedFileRevision: {
            path: 'kortix.yaml',
            sha: revision,
            candidatePaths: ['kortix.yaml', 'kortix.yml', 'kortix.toml'],
          },
        }),
      ).rejects.toBeInstanceOf(GitFileRevisionConflictError);

      // The competing commit really landed, so the conflict was the live tip.
      expect(await git(['--git-dir', remote, 'show', 'main:README.md'])).toContain('# competing');
    } finally {
      if (previousCacheDir === undefined) delete process.env.KORTIX_GIT_CACHE_DIR;
      else process.env.KORTIX_GIT_CACHE_DIR = previousCacheDir;
    }
  });
});
