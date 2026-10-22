/**
 * A forced mirror read must not fail because ANOTHER caller's refresh failed.
 *
 * `POST /projects/create-repo` starts the template prebuild, which cold-clones
 * the mirror with the token create-repo held. The first session on the new
 * project arrives while that clone is in flight and forces its own manifest
 * read. The mirror joined the forced read to the in-flight refresh and
 * rethrew ITS error, so a clone that failed under the prebuild's credential
 * failed the session with `503 git_mirror_unavailable` — although the session's
 * own credential could clone the repository.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { refreshMirror } from './mirror';

const exec = promisify(execFile);
let testRoot = '';
const savedCacheDir = process.env.KORTIX_GIT_CACHE_DIR;

beforeEach(async () => {
  testRoot = await mkdtemp(join(tmpdir(), 'kortix-mirror-forced-'));
  process.env.KORTIX_GIT_CACHE_DIR = join(testRoot, 'git-cache');
});

afterEach(async () => {
  if (savedCacheDir === undefined) delete process.env.KORTIX_GIT_CACHE_DIR;
  else process.env.KORTIX_GIT_CACHE_DIR = savedCacheDir;
  await rm(testRoot, { recursive: true, force: true });
});

test('a forced read runs its own refresh when the in-flight one fails', async () => {
  const remote = join(testRoot, 'remote.git');
  const work = join(testRoot, 'work');
  await exec('git', ['init', '--bare', '--initial-branch=main', remote]);
  await exec('git', ['init', '--initial-branch=main', work]);
  await exec('git', ['-C', work, '-c', 'user.name=t', '-c', 'user.email=t@kortix.invalid', 'commit', '--allow-empty', '-m', 'seed']);
  await exec('git', ['-C', work, 'push', remote, 'main']);

  const projectId = `mirror-forced-${crypto.randomUUID()}`;
  const base = { projectId, defaultBranch: 'main', manifestPath: 'kortix.yaml' };

  // The prebuild's refresh: a credential that cannot reach the repository.
  const prebuild = refreshMirror({ ...base, repoUrl: join(testRoot, 'unreachable.git'), gitAuthToken: 'prebuild' });
  // The session's forced read, with a credential that can.
  const session = refreshMirror({ ...base, repoUrl: remote, gitAuthToken: 'session' }, true);

  await expect(prebuild).rejects.toThrow();
  const repoPath = await session;
  const { stdout } = await exec('git', ['-C', repoPath, 'rev-parse', 'refs/heads/main']);
  expect(stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
});
