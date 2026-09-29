import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { runWithContext } from '../../lib/request-context';
import { allowStaleMirrorReads, invalidateProjectMirror, refreshMirror } from './mirror';
import type { GitBackedProject } from './types';

const exec = promisify(execFile);

let testRoot = '';
let remotePath = '';
let repositoryPath = '';
let project: GitBackedProject;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ['KORTIX_GIT_CACHE_DIR', 'KORTIX_GIT_REFRESH_INTERVAL_MS', 'KORTIX_GIT_VIEW_MAX_STALE_MS'];

async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await exec('git', args, { cwd });
  return stdout.trim();
}

async function commit(content: string): Promise<string> {
  await writeFile(join(repositoryPath, 'kortix.yaml'), content);
  await git(['add', 'kortix.yaml'], repositoryPath);
  await git(['commit', '-m', content], repositoryPath);
  await git(['push', 'origin', 'main'], repositoryPath);
  return git(['rev-parse', 'HEAD'], repositoryPath);
}

/** A page-view read: the request opted in to stale-while-revalidate. */
function viewRead(): Promise<string> {
  return runWithContext('GET', '/v1/projects/x/detail', () => {
    allowStaleMirrorReads();
    return refreshMirror(project);
  });
}

async function mirrorTip(repoPath: string): Promise<string> {
  return git(['rev-parse', 'refs/heads/main'], repoPath);
}

async function waitForTip(repoPath: string, sha: string): Promise<string> {
  const deadline = Date.now() + 10_000;
  let tip = await mirrorTip(repoPath);
  while (tip !== sha && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    tip = await mirrorTip(repoPath);
  }
  return tip;
}

beforeEach(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  testRoot = await mkdtemp(join(tmpdir(), 'kortix-mirror-view-stale-'));
  remotePath = join(testRoot, 'remote.git');
  repositoryPath = join(testRoot, 'repository');
  process.env.KORTIX_GIT_CACHE_DIR = join(testRoot, 'git-cache');
  // Every read is past the refresh interval, so only the view opt-in can skip a fetch.
  process.env.KORTIX_GIT_REFRESH_INTERVAL_MS = '0';
  delete process.env.KORTIX_GIT_VIEW_MAX_STALE_MS;

  await mkdir(repositoryPath);
  await git(['init', '--bare', remotePath]);
  await git(['init', '--initial-branch=main', repositoryPath]);
  await git(['config', 'user.name', 'Kortix Test'], repositoryPath);
  await git(['config', 'user.email', 'test@kortix.invalid'], repositoryPath);
  await git(['remote', 'add', 'origin', remotePath], repositoryPath);
  await commit('seed');
  await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], remotePath);

  project = {
    projectId: `mirror-view-stale-${crypto.randomUUID()}`,
    repoUrl: remotePath,
    defaultBranch: 'main',
    manifestPath: 'kortix.yaml',
    gitAuthToken: 'local-test',
  };
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await rm(testRoot, { recursive: true, force: true });
});

describe('page-view mirror reads', () => {
  test('serve the warm mirror at once and refresh it behind the response', async () => {
    const repoPath = await viewRead(); // cold: clones, blocking
    const seeded = await mirrorTip(repoPath);
    const pushed = await commit('pushed outside Kortix');

    expect(await viewRead()).toBe(repoPath);
    // Answered from the mirror as it was: the push is not in it yet ...
    expect(await mirrorTip(repoPath)).toBe(seeded);
    // ... and the read started the fetch that brings it in.
    expect(await waitForTip(repoPath, pushed)).toBe(pushed);
  });

  test('block on a fetch after a base-branch move was announced', async () => {
    const repoPath = await viewRead();
    const pushed = await commit('pushed through Kortix');
    invalidateProjectMirror(project.projectId);

    await viewRead();

    expect(await mirrorTip(repoPath)).toBe(pushed);
  });

  test('block on a fetch once the mirror is older than the view bound', async () => {
    const repoPath = await viewRead();
    const pushed = await commit('old mirror');
    process.env.KORTIX_GIT_VIEW_MAX_STALE_MS = '1';
    await new Promise((resolve) => setTimeout(resolve, 5));

    await viewRead();

    expect(await mirrorTip(repoPath)).toBe(pushed);
  });

  test('readers that did not opt in keep fetching past the interval', async () => {
    const repoPath = await refreshMirror(project);
    const pushed = await commit('sweep read');

    await refreshMirror(project);

    expect(await mirrorTip(repoPath)).toBe(pushed);
  });
});
