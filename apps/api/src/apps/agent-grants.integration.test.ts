import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { readAgentsGrantingApp } from './agent-grants';
import type { GitBackedProject } from '../projects/git/types';

// Release gate AGP-9 (v0.13.31): the grant was written to kortix.yaml on the
// default branch, and GET /apps/:appId/agents, served by an API replica with a
// warm mirror, still answered the old list. This suite is that replica: the
// mirror is read once, the grant lands on the remote, and the next read must
// see it inside the refresh interval.

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

function manifest(bystanderApps: string | null): string {
  return [
    'kortix_version: 2',
    'default_agent: reporter',
    'agents:',
    '  reporter:',
    '    apps: [dashboards]',
    '  bystander:',
    ...(bystanderApps ? [`    apps: ${bystanderApps}`] : ['    description: no app grant']),
    '',
  ].join('\n');
}

async function pushManifest(text: string): Promise<void> {
  await writeFile(join(workPath, 'kortix.yaml'), text);
  await git(['add', 'kortix.yaml'], workPath);
  await git(['commit', '-q', '-m', 'grant'], workPath);
  await git(['push', '-q', 'origin', 'main'], workPath);
}

beforeEach(async () => {
  testRoot = await mkdtemp(join(tmpdir(), 'kortix-app-agent-grants-'));
  remotePath = join(testRoot, 'remote.git');
  workPath = join(testRoot, 'work');
  previousCacheDir = process.env.KORTIX_GIT_CACHE_DIR;
  previousRefreshInterval = process.env.KORTIX_GIT_REFRESH_INTERVAL_MS;
  process.env.KORTIX_GIT_CACHE_DIR = join(testRoot, 'git-cache');
  // One hour: without a forced refresh every read serves the warm mirror.
  process.env.KORTIX_GIT_REFRESH_INTERVAL_MS = '3600000';

  await mkdir(workPath);
  await git(['init', '-q', '--bare', remotePath]);
  await git(['init', '-q', '--initial-branch=main', workPath]);
  await git(['config', 'user.name', 'Kortix Test'], workPath);
  await git(['config', 'user.email', 'test@kortix.invalid'], workPath);
  await writeFile(join(workPath, 'kortix.yaml'), manifest(null));
  await git(['add', '-A'], workPath);
  await git(['commit', '-q', '-m', 'seed'], workPath);
  await git(['remote', 'add', 'origin', remotePath], workPath);
  await git(['push', '-q', 'origin', 'main'], workPath);
  await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], remotePath);

  project = {
    projectId: `app-agent-grants-${crypto.randomUUID()}`,
    repoUrl: remotePath,
    defaultBranch: 'main',
    manifestPath: 'kortix.yaml',
    gitAuthToken: 'local-test',
  };
});

afterEach(async () => {
  if (previousCacheDir === undefined) delete process.env.KORTIX_GIT_CACHE_DIR;
  else process.env.KORTIX_GIT_CACHE_DIR = previousCacheDir;
  if (previousRefreshInterval === undefined) delete process.env.KORTIX_GIT_REFRESH_INTERVAL_MS;
  else process.env.KORTIX_GIT_REFRESH_INTERVAL_MS = previousRefreshInterval;
  await rm(testRoot, { recursive: true, force: true });
});

const names = (grants: Array<{ agent_name: string }>) => grants.map((g) => g.agent_name);

describe('readAgentsGrantingApp on a warm mirror', () => {
  test('a grant pushed after the first read is listed by the next read', async () => {
    expect(names(await readAgentsGrantingApp(project, 'dashboards'))).toEqual(['reporter']);

    await pushManifest(manifest('[dashboards]'));

    expect(names(await readAgentsGrantingApp(project, 'dashboards'))).toEqual(['bystander', 'reporter']);
  });

  test('a grant removed after the first read is gone from the next read', async () => {
    await pushManifest(manifest('all'));
    expect(await readAgentsGrantingApp(project, 'dashboards')).toEqual([
      { agent_name: 'bystander', grant: 'all', path: 'kortix.yaml#agents.bystander' },
      { agent_name: 'reporter', grant: 'listed', path: 'kortix.yaml#agents.reporter' },
    ]);

    await pushManifest(manifest(null));

    expect(names(await readAgentsGrantingApp(project, 'dashboards'))).toEqual(['reporter']);
  });
});
