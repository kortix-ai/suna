import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { manifestChangeRequiredActions } from './change-request-governance';
import { refreshMirror } from '../git/mirror';
import type { GitBackedProject } from '../git/types';

// Release gate GH-17 / AGP-10 (v0.13.31): an agent session pushed its branch,
// opened a change request, and merged it seconds later. The merge landed on an
// API replica whose mirror had refreshed less than the refresh interval ago,
// so the just-pushed head branch did not resolve, and a README-only change was
// refused. This suite reproduces that replica: a warm mirror with a long
// refresh interval.

const exec = promisify(execFile);

let testRoot = '';
let remotePath = '';
let workPath = '';
let project: GitBackedProject;
let previousCacheDir: string | undefined;
let previousRefreshInterval: string | undefined;

async function git(args: string[], cwd?: string): Promise<void> {
  await exec('git', args, { cwd });
}

const MANIFEST = [
  'kortix_version: 2',
  'default_agent: builder',
  'agents:',
  '  builder:',
  '    kortix_permissions: [project.gitops.push, project.gitops.merge]',
  '',
].join('\n');

async function pushBranch(branch: string, files: Record<string, string>): Promise<void> {
  await git(['checkout', '-q', '-B', branch, 'main'], workPath);
  for (const [path, content] of Object.entries(files)) {
    await writeFile(join(workPath, path), content);
  }
  await git(['add', '-A'], workPath);
  await git(['commit', '-q', '-m', `change on ${branch}`], workPath);
  await git(['push', '-q', 'origin', `${branch}:refs/heads/${branch}`], workPath);
  await git(['checkout', '-q', 'main'], workPath);
}

beforeEach(async () => {
  testRoot = await mkdtemp(join(tmpdir(), 'kortix-cr-governance-'));
  remotePath = join(testRoot, 'remote.git');
  workPath = join(testRoot, 'work');
  previousCacheDir = process.env.KORTIX_GIT_CACHE_DIR;
  previousRefreshInterval = process.env.KORTIX_GIT_REFRESH_INTERVAL_MS;
  process.env.KORTIX_GIT_CACHE_DIR = join(testRoot, 'git-cache');
  // One hour: every unforced read inside the test serves the warm mirror.
  process.env.KORTIX_GIT_REFRESH_INTERVAL_MS = '3600000';

  await mkdir(workPath);
  await git(['init', '-q', '--bare', remotePath]);
  await git(['init', '-q', '--initial-branch=main', workPath]);
  await git(['config', 'user.name', 'Kortix Test'], workPath);
  await git(['config', 'user.email', 'test@kortix.invalid'], workPath);
  await writeFile(join(workPath, 'kortix.yaml'), MANIFEST);
  await writeFile(join(workPath, 'README.md'), '# seed\n');
  await git(['add', '-A'], workPath);
  await git(['commit', '-q', '-m', 'seed'], workPath);
  await git(['remote', 'add', 'origin', remotePath], workPath);
  await git(['push', '-q', 'origin', 'main'], workPath);
  await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], remotePath);

  project = {
    projectId: `cr-governance-${crypto.randomUUID()}`,
    repoUrl: remotePath,
    defaultBranch: 'main',
    manifestPath: 'kortix.yaml',
    gitAuthToken: 'local-test',
  };
  // Warm the mirror BEFORE the session branch exists, as the replica that
  // served an earlier request of the same flow had.
  await refreshMirror(project);
});

afterEach(async () => {
  if (previousCacheDir === undefined) delete process.env.KORTIX_GIT_CACHE_DIR;
  else process.env.KORTIX_GIT_CACHE_DIR = previousCacheDir;
  if (previousRefreshInterval === undefined) delete process.env.KORTIX_GIT_REFRESH_INTERVAL_MS;
  else process.env.KORTIX_GIT_REFRESH_INTERVAL_MS = previousRefreshInterval;
  await rm(testRoot, { recursive: true, force: true });
});

describe('manifestChangeRequiredActions on a warm mirror', () => {
  test('a branch pushed after the mirror warmed, changing only README, needs nothing extra', async () => {
    await pushBranch('session-readme', { 'README.md': '# seed\n\nagent note\n' });
    expect(await manifestChangeRequiredActions(project, { baseRef: 'main', headRef: 'session-readme' })).toEqual([]);
  });

  test('a branch pushed after the mirror warmed, adding a trigger, needs project.trigger.create', async () => {
    await pushBranch('session-trigger', {
      'kortix.yaml': `${MANIFEST}triggers:\n  - slug: hourly\n    type: cron\n    cron: "0 0 * * * *"\n    prompt: run\n`,
    });
    expect(await manifestChangeRequiredActions(project, { baseRef: 'main', headRef: 'session-trigger' })).toEqual([
      'project.trigger.create',
    ]);
  });

  test('a branch widening its own agent needs project.agent.write', async () => {
    await pushBranch('session-widen', { 'kortix.yaml': MANIFEST.replace('[project.gitops.push, project.gitops.merge]', 'all') });
    expect(await manifestChangeRequiredActions(project, { baseRef: 'main', headRef: 'session-widen' })).toEqual([
      'project.agent.write',
    ]);
  });

  test('a head ref that does not exist on the remote throws (the route answers 503), never a guess', async () => {
    await expect(
      manifestChangeRequiredActions(project, { baseRef: 'main', headRef: 'session-never-pushed' }),
    ).rejects.toThrow();
  });
});
