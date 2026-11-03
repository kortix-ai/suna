import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadProjectAgents } from '../agents';
import { invalidateProjectMirror, provenMirrorTip, publishTipProofsTo, refreshMirror, repoCachePath } from './mirror';
import type { GitBackedProject } from './types';

/** The connectors an enabled agent declares as required, read off the loaded manifest. */
const requiredConnectorsForAgent = (name: string, loaded: Awaited<ReturnType<typeof loadProjectAgents>>) =>
  loaded.specs.find((spec) => spec.name === name && spec.enabled)?.connectorsRequired ?? [];

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

/**
 * From here on, every fetch the mirror makes reads the remote's refs at once
 * and receives them 1.5 s later: protocol v0 advertises refs when upload-pack
 * starts, and the pipe holds its output back. A fetch that spans a push
 * therefore lands the tip from before it.
 */
async function slowRemoteFetches(): Promise<void> {
  const slowUploadPack = join(testRoot, 'slow-upload-pack');
  await writeFile(slowUploadPack, '#!/bin/sh\ngit-upload-pack "$@" | (sleep 1.5; cat)\n');
  await chmod(slowUploadPack, 0o755);
  const mirror = repoCachePath(project);
  await git(['config', 'remote.origin.uploadpack', slowUploadPack], mirror);
  await git(['config', 'protocol.version', '0'], mirror);
}

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
    // current, so the mirror fetches that branch alone and does not transfer
    // the repository — a ref pushed in the meantime is deliberately NOT
    // mirrored by this call. That absence is the observable difference between
    // the single-branch fetch and the whole-mirror fetch it replaces.
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

  test('a forced manifest read of a moved branch fetches that branch alone', async () => {
    await loadProjectAgents(project);
    await git(['branch', 'unrelated'], repositoryPath);
    await git(['push', 'origin', 'unrelated'], repositoryPath);
    await pushRequiredManifest();

    const agents = await loadProjectAgents(project, { forceRefresh: true });
    expect(requiredConnectorsForAgent('support', agents)).toEqual(['required-check']);
    const unrelated = await exec('git', ['rev-parse', '--verify', '--quiet', 'refs/heads/unrelated'], {
      cwd: repoCachePath(project),
    }).then(
      () => 'present',
      () => 'absent',
    );
    expect(unrelated).toBe('absent');
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
      await pushRequiredManifest();
      invalidateProjectMirror(project.projectId);
      await inFlight;

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

    describe('shared proofs', () => {
      let published: Array<{ ref: string; tip: string; askedAt: number }> = [];
      /** When each proof was handed to the publisher. */
      let publishedAt: number[] = [];
      beforeEach(() => {
        published = [];
        publishedAt = [];
        publishTipProofsTo(async (projectId, ref, tip, askedAt) => {
          if (projectId !== project.projectId) return;
          published.push({ ref, tip, askedAt });
          publishedAt.push(Date.now());
        });
      });
      afterEach(() => publishTipProofsTo(null));
      /** Publishing runs behind the read. */
      const settled = async (expected: number) => {
        for (let i = 0; i < 100 && published.length < expected; i++) await Bun.sleep(10);
        await Bun.sleep(30);
      };
      const remoteMain = async () => (await exec('git', ['rev-parse', 'refs/heads/main'], { cwd: remotePath })).stdout.trim();

      test('a read that asked the remote shares the tip it saw and when it asked', async () => {
        const before = Date.now();
        await required(tipProof);
        const after = Date.now();
        await settled(1);

        expect(published.map(({ ref, tip }) => ({ ref, tip }))).toEqual([{ ref: 'main', tip: await remoteMain() }]);
        expect(published[0]!.askedAt).toBeGreaterThanOrEqual(before);
        expect(published[0]!.askedAt).toBeLessThanOrEqual(after);
      });

      test('a read answered from its proof shares nothing: it did not ask', async () => {
        await required(tipProof);
        await settled(1);
        published = [];

        await required(tipProof);
        await settled(0);
        expect(published).toEqual([]);
      });

      test('a proof in flight across a base move is not shared; the retried read shares the moved tip', async () => {
        await loadProjectAgents(project);
        await settled(1);
        const oldTip = await remoteMain();
        // The read below is still fetching when the move is announced.
        await slowRemoteFetches();
        invalidateProjectMirror(project.projectId);
        const inFlight = refreshMirror(project, 'tip-proof', { freshRef: 'main' });
        await pushRequiredManifest();
        const movedAt = Date.now();
        invalidateProjectMirror(project.projectId);
        await inFlight;
        await settled(published.length + 1);

        const staleAfterMove = published.filter((proof, i) => proof.tip === oldTip && publishedAt[i]! >= movedAt);
        expect(staleAfterMove).toEqual([]);
        expect(published.at(-1)).toMatchObject({ ref: 'main', tip: await remoteMain() });
        expect(published.at(-1)!.askedAt).toBeGreaterThanOrEqual(movedAt);
      }, 20_000);
    });

    test('a read whose proof stands does not wait out another caller\'s fetch; a moved base still does', async () => {
      await required(tipProof);
      await slowRemoteFetches();

      const otherFetch = refreshMirror(project, true);
      const started = performance.now();
      await refreshMirror(project, 'tip-proof', { freshRef: 'main' });
      expect(performance.now() - started).toBeLessThan(500);
      await otherFetch;

      // After a move the proof is gone: the read queues behind the fetch, as before.
      invalidateProjectMirror(project.projectId);
      const nextFetch = refreshMirror(project, true);
      const queued = performance.now();
      await refreshMirror(project, 'tip-proof', { freshRef: 'main' });
      expect(performance.now() - queued).toBeGreaterThan(1_000);
      await nextFetch;
    }, 20_000);

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
