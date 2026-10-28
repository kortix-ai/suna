import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { repoCachePath } from './git/mirror';
import type { GitBackedProject } from './git/types';
import { readManifest } from './manifest-io';

const exec = promisify(execFile);

let testRoot = '';
let repositoryPath = '';
let project: GitBackedProject;
let previousCacheDir: string | undefined;

async function git(args: string[], cwd?: string): Promise<void> {
  await exec('git', args, { cwd });
}

async function pushManifest(connector: string): Promise<void> {
  await writeFile(
    join(repositoryPath, 'kortix.yaml'),
    ['kortix_version: 2', 'default_agent: support', 'agents:', '  support:', `    connectors: [${connector}]`, ''].join('\n'),
  );
  await git(['add', 'kortix.yaml'], repositoryPath);
  await git(['commit', '-m', connector], repositoryPath);
  await git(['push', 'origin', 'main'], repositoryPath);
}

const connectorsRead = (manifest: Awaited<ReturnType<typeof readManifest>>) =>
  (manifest?.raw.agents as { support: { connectors: string[] } }).support.connectors;

beforeEach(async () => {
  testRoot = await mkdtemp(join(tmpdir(), 'kortix-manifest-reuse-at-tip-'));
  const remotePath = join(testRoot, 'remote.git');
  repositoryPath = join(testRoot, 'repository');
  previousCacheDir = process.env.KORTIX_GIT_CACHE_DIR;
  process.env.KORTIX_GIT_CACHE_DIR = join(testRoot, 'git-cache');

  await mkdir(repositoryPath);
  await git(['init', '--bare', remotePath]);
  await git(['init', '--initial-branch=main', repositoryPath]);
  await git(['config', 'user.name', 'Kortix Test'], repositoryPath);
  await git(['config', 'user.email', 'test@kortix.invalid'], repositoryPath);
  await git(['remote', 'add', 'origin', remotePath], repositoryPath);
  await pushManifest('first');
  await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], remotePath);

  project = {
    projectId: `manifest-reuse-at-tip-${crypto.randomUUID()}`,
    repoUrl: remotePath,
    defaultBranch: 'main',
    manifestPath: 'kortix.yaml',
    gitAuthToken: 'local-test',
  };
});

afterEach(async () => {
  if (previousCacheDir === undefined) delete process.env.KORTIX_GIT_CACHE_DIR;
  else process.env.KORTIX_GIT_CACHE_DIR = previousCacheDir;
  await rm(testRoot, { recursive: true, force: true });
});

test('a sweep read clones no evicted mirror while the default branch is unchanged, and reads a push', async () => {
  expect(connectorsRead(await readManifest(project, { reuseAtTip: true }))).toEqual(['first']);

  // The cache reaper evicts the mirror. Before, the next sweep cloned it again.
  await rm(repoCachePath(project), { recursive: true, force: true });
  expect(connectorsRead(await readManifest(project, { reuseAtTip: true }))).toEqual(['first']);
  expect(existsSync(repoCachePath(project))).toBe(false);

  await pushManifest('second');
  expect(connectorsRead(await readManifest(project, { reuseAtTip: true }))).toEqual(['second']);
});
