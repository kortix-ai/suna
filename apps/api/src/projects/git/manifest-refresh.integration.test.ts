import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadProjectAgents, requiredConnectorsForAgent } from '../agents';
import { invalidateProjectMirror, provenMirrorTip, refreshMirror, repoCachePath } from './mirror';
import type { GitBackedProject } from './types';

const exec = promisify(execFile);

let testRoot = '';
let remotePath = '';
let repositoryPath = '';
let project: GitBackedProject;
let previousCacheDir: string | undefined;
let previousRefreshInterval: string | undefined;

async function git(args: string[], cwd?: string): Promise<void> {
  await exec('git', args, { cwd });
}

async function writeManifest(required: boolean): Promise<void> {
  await writeFile(
    join(repositoryPath, 'kortix.yaml'),
    [
      'kortix_version: 2',
      'default_agent: support',
      'agents:',
      '  support:',
      '    connectors: [required-check]',
      ...(required ? ['    connectors_required: [required-check]'] : []),
      '',
    ].join('\n'),
  );
}

async function pushRequiredManifest(): Promise<void> {
  await writeManifest(true);
  await git(['add', 'kortix.yaml'], repositoryPath);
  await git(['commit', '-m', 'require connector'], repositoryPath);
  await git(['push', 'origin', 'main'], repositoryPath);
}

beforeEach(async () => {
  testRoot = await mkdtemp(join(tmpdir(), 'kortix-manifest-refresh-'));
  remotePath = join(testRoot, 'remote.git');
  repositoryPath = join(testRoot, 'repository');
  previousCacheDir = process.env.KORTIX_GIT_CACHE_DIR;
  previousRefreshInterval = process.env.KORTIX_GIT_REFRESH_INTERVAL_MS;
  process.env.KORTIX_GIT_CACHE_DIR = join(testRoot, 'git-cache');
  process.env.KORTIX_GIT_REFRESH_INTERVAL_MS = '3600000';

  await mkdir(repositoryPath);
  await git(['init', '--bare', remotePath]);
  await git(['init', '--initial-branch=main', repositoryPath]);
  await git(['config', 'user.name', 'Kortix Test'], repositoryPath);
  await git(['config', 'user.email', 'test@kortix.invalid'], repositoryPath);
  await writeManifest(false);
  await git(['add', 'kortix.yaml'], repositoryPath);
  await git(['commit', '-m', 'seed manifest'], repositoryPath);
  await git(['remote', 'add', 'origin', remotePath], repositoryPath);
  await git(['push', 'origin', 'main'], repositoryPath);
  await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], remotePath);

  project = {
    projectId: `manifest-refresh-${crypto.randomUUID()}`,
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

describe('manifest refresh', () => {
  test('a forced agent load observes a remote governance update during the cache interval', async () => {
    const initial = await loadProjectAgents(project);
    expect(requiredConnectorsForAgent('support', initial)).toEqual([]);

    await pushRequiredManifest();

    const cached = await loadProjectAgents(project);
    expect(requiredConnectorsForAgent('support', cached)).toEqual([]);

    const refreshed = await loadProjectAgents(project, { forceRefresh: true });
    expect(requiredConnectorsForAgent('support', refreshed)).toEqual(['required-check']);
  });

  test('a forced manifest read skips the fetch when its branch has not moved', async () => {
    // The per-prompt grant read forces a refresh purely to keep ONE branch
    // current. When that branch is already at the remote's tip, the mirror
    // proves it with a single `ls-remote` and does not transfer the repository
    // — so a ref pushed in the meantime is deliberately NOT mirrored by this
    // call. That absence is the observable difference between the cheap proof
    // and the fetch it replaces.
    await loadProjectAgents(project);
    await git(['branch', 'unrelated'], repositoryPath);
    await git(['push', 'origin', 'unrelated'], repositoryPath);

    await loadProjectAgents(project, { forceRefresh: true });

    const mirror = repoCachePath(project);
    const unrelated = await exec('git', ['rev-parse', '--verify', '--quiet', 'refs/heads/unrelated'], {
      cwd: mirror,
    }).then(
      () => 'present',
      () => 'absent',
    );
    expect(unrelated).toBe('absent');
    // …and the manifest itself still reads, from the branch that did not move.
    const agents = await loadProjectAgents(project, { forceRefresh: true });
    expect(requiredConnectorsForAgent('support', agents)).toEqual([]);
  });

  describe('tip-proof reads (the per-prompt grant read)', () => {
    const tipProof = { forceRefresh: 'tip-proof' } as const;
    const required = async (opts?: Parameters<typeof loadProjectAgents>[1]) =>
      requiredConnectorsForAgent('support', await loadProjectAgents(project, opts));

    test('a second read inside the interval reuses the proof and does not ask the remote', async () => {
      expect(await required(tipProof)).toEqual([]);
      // A push the API never saw: straight to the upstream, no invalidation.
      await pushRequiredManifest();

      expect(await required(tipProof)).toEqual([]);
      // A strict forced read is not served from the proof.
      expect(await required({ forceRefresh: true })).toEqual(['required-check']);
    });

    test('a base move the API saw drops the proof, so the next read is current', async () => {
      expect(await required(tipProof)).toEqual([]);
      await pushRequiredManifest();
      invalidateProjectMirror(project.projectId);

      expect(await required(tipProof)).toEqual(['required-check']);
    });

    test('a move announced while the proof is in flight is not overwritten by it', async () => {
      await loadProjectAgents(project);
      invalidateProjectMirror(project.projectId);
      // Called directly: the refresh starts in this tick, before the move.
      const inFlight = refreshMirror(project, 'tip-proof', { freshRef: 'main' });
      invalidateProjectMirror(project.projectId);
      await inFlight;
      await pushRequiredManifest();

      expect(await required(tipProof)).toEqual(['required-check']);
    });

    test('a proven branch answers its tip from the mirror; an unproven one answers nothing', async () => {
      expect(await provenMirrorTip(project, 'main')).toBeNull();
      await required(tipProof);
      const { stdout } = await exec('git', ['rev-parse', 'refs/heads/main'], { cwd: remotePath });

      expect(await provenMirrorTip(project, 'main')).toBe(stdout.trim());
      // A branch nobody proved is not answered from the mirror.
      expect(await provenMirrorTip(project, 'other')).toBeNull();
      invalidateProjectMirror(project.projectId);
      expect(await provenMirrorTip(project, 'main')).toBeNull();
    });

    test('an expired proof is re-proved against the remote', async () => {
      expect(await required(tipProof)).toEqual([]);
      await pushRequiredManifest();
      process.env.KORTIX_GIT_REFRESH_INTERVAL_MS = '0';

      expect(await required(tipProof)).toEqual(['required-check']);
    });
  });

  test('a forced refresh remains forced when a cached refresh already holds the lock', async () => {
    await loadProjectAgents(project);
    await pushRequiredManifest();

    await Promise.all([refreshMirror(project), refreshMirror(project, true)]);

    const refreshed = await loadProjectAgents(project);
    expect(requiredConnectorsForAgent('support', refreshed)).toEqual(['required-check']);
  });
});
