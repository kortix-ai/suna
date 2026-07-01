/**
 * Regression test for the shared git-mirror auth race.
 *
 * The per-project bare mirror (`git/mirror.ts`) is hit by ~15 code paths, several
 * of which legitimately resolve `gitAuthToken` to null. Because `refreshMirror`
 * dedups concurrent refreshes by projectId, ONE tokenless caller winning the lock
 * used to make the cold bare-clone of a PRIVATE repo run unauthenticated
 * (`fatal: could not read Username for 'https://github.com'`) — failing every
 * concurrent caller, including a token-bearing session start. That surfaced to
 * users as the misleading "Provisioning failed via daytona."
 *
 * The fix makes the mirror auth-self-sufficient: when the caller didn't pass a
 * token, `refreshMirror` lazily resolves one from the project's stored
 * credentials before the network git op. These tests prove:
 *   1. A tokenless refresh invokes the lazy resolver (so a private clone is
 *      authenticated regardless of which caller won the lock).
 *   2. A token-bearing refresh does NOT pay the extra resolution.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Records every projectId the lazy resolver was asked about. mirror.ts reaches
// this through `await import('../lib/git')`; mocking the module keeps its heavy
// transitive imports (db, github, …) out of the unit test entirely.
const resolverCalls: string[] = [];
mock.module('../projects/lib/git', () => ({
  resolveProjectGitAuthTokenById: async (projectId: string) => {
    resolverCalls.push(projectId);
    return 'resolved-sentinel-token';
  },
}));

const { refreshMirror, repoCachePath } = await import('../projects/git/mirror');

let workdir: string;
let upstream: string;
let cacheDir: string;

async function git(args: string[], cwd: string) {
  await execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@t.t',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@t.t',
    },
  });
}

beforeEach(async () => {
  resolverCalls.length = 0;
  workdir = await mkdtemp(join(tmpdir(), 'mirror-auth-'));
  upstream = join(workdir, 'upstream');
  cacheDir = join(workdir, 'cache');
  await mkdir(upstream, { recursive: true });
  await git(['init', '-b', 'main'], upstream);
  await writeFile(join(upstream, 'README.md'), '# hi\n');
  await git(['add', '.'], upstream);
  await git(['commit', '-m', 'init'], upstream);
  // mirror.ts reads KORTIX_GIT_CACHE_DIR at call time.
  process.env.KORTIX_GIT_CACHE_DIR = cacheDir;
});

afterAll(async () => {
  delete process.env.KORTIX_GIT_CACHE_DIR;
});

describe('refreshMirror auth self-sufficiency', () => {
  test('a tokenless refresh resolves auth lazily, then completes the clone', async () => {
    const project = {
      projectId: 'aaaaaaaa-0000-0000-0000-000000000001',
      repoUrl: upstream,
      defaultBranch: 'main',
      manifestPath: '',
      // No gitAuthToken — the exact shape that used to clone unauthenticated.
    };

    const repoPath = await refreshMirror(project as never);

    // The lazy resolver ran for THIS project before the network git op — the
    // shared clone is now authenticated whoever wins the refresh lock.
    expect(resolverCalls).toContain(project.projectId);
    // And the clone actually landed.
    expect(repoPath).toBe(repoCachePath(project as never));
    expect(existsSync(join(repoPath, 'HEAD'))).toBe(true);
  });

  test('a token-bearing refresh skips the extra resolution', async () => {
    const project = {
      projectId: 'bbbbbbbb-0000-0000-0000-000000000002',
      repoUrl: upstream,
      defaultBranch: 'main',
      manifestPath: '',
      gitAuthToken: 'caller-supplied-token',
    };

    const repoPath = await refreshMirror(project as never);

    expect(resolverCalls).not.toContain(project.projectId);
    expect(existsSync(join(repoPath, 'HEAD'))).toBe(true);
  });
});
