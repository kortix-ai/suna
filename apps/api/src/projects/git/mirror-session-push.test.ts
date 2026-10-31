/**
 * Which reads ask the remote, against real git repositories. "Asks the remote"
 * is observed by moving the remote away: a read that needs no network still
 * answers, and a read that fetches fails.
 */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  invalidateProjectMirror,
  mirrorHoldsBranch,
  noteSessionBranchPushed,
  refreshMirror,
  useSharedTipProof,
} from './mirror';

const exec = promisify(execFile);
const previousCache = process.env.KORTIX_GIT_CACHE_DIR;
let root = '';

afterEach(async () => {
  useSharedTipProof(null);
  if (previousCache === undefined) delete process.env.KORTIX_GIT_CACHE_DIR;
  else process.env.KORTIX_GIT_CACHE_DIR = previousCache;
  if (root) await fs.rm(root, { recursive: true, force: true });
});

async function world() {
  root = await fs.mkdtemp(join(tmpdir(), 'kortix-mirror-session-push-'));
  process.env.KORTIX_GIT_CACHE_DIR = join(root, 'cache');
  const remote = join(root, 'remote.git');
  const parked = join(root, 'remote-away.git');
  const work = join(root, 'work');
  const git = async (...args: string[]) => (await exec('git', args)).stdout.trim();
  await git('init', '--bare', '--initial-branch=main', remote);
  await git('init', '--initial-branch=main', work);
  const commit = (message: string) =>
    git('-C', work, '-c', 'user.name=Test', '-c', 'user.email=agent@kortix.ai', 'commit', '--allow-empty', '-m', message);
  await commit('seed');
  await git('-C', work, 'push', remote, 'main');
  const project = {
    projectId: crypto.randomUUID(),
    repoUrl: remote,
    defaultBranch: 'main',
    manifestPath: 'kortix.yaml',
    gitAuthToken: 'synthetic',
  };
  return {
    project,
    git,
    commit,
    work,
    remote,
    /** Every fetch fails until `back()`. */
    away: () => fs.rename(remote, parked),
    back: () => fs.rename(parked, remote),
    tip: () => git('-C', work, 'rev-parse', 'HEAD'),
  };
}

/** Run with the clock moved past one refresh interval (60 s), so this process's own proofs expired. */
async function later<T>(fn: () => Promise<T>): Promise<T> {
  const now = Date.now() + 120_000;
  const clock = spyOn(Date, 'now').mockReturnValue(now);
  try {
    return await fn();
  } finally {
    clock.mockRestore();
  }
}

test('a session-branch push keeps the base proof, and the next plain read fetches the session branch', async () => {
  const w = await world();
  await refreshMirror(w.project, true);
  const session = crypto.randomUUID();
  await w.commit('session work');
  await w.git('-C', w.work, 'push', w.remote, `HEAD:refs/heads/${session}`);

  noteSessionBranchPushed(w.project.projectId);

  await w.away();
  // The prompt's grant read: the base was proven moments ago, so no fetch.
  const checkout = await refreshMirror(w.project, 'tip-proof', { freshRef: 'main' });
  expect(checkout).toBeTruthy();
  // A plain read fetches: it fails while the remote is away.
  await expect(refreshMirror(w.project)).rejects.toThrow();
  await w.back();
  const fetched = await refreshMirror(w.project);
  expect(await w.git('-C', fetched, 'rev-parse', `refs/heads/${session}`)).toBe(await w.tip());
});

test('an invalidation still drops the base proof: the next grant read fetches', async () => {
  const w = await world();
  await refreshMirror(w.project, true);
  invalidateProjectMirror(w.project.projectId);
  await w.away();
  await expect(refreshMirror(w.project, 'tip-proof', { freshRef: 'main' })).rejects.toThrow();
});

test("another process's fresh proof of the tip this mirror holds is adopted without a fetch", async () => {
  const w = await world();
  await refreshMirror(w.project, true);
  const tip = await w.tip();
  await w.away();
  await later(async () => {
    useSharedTipProof(async (projectId, ref) =>
      projectId === w.project.projectId && ref === 'main' ? { tip, provenAt: Date.now() - 1_000 } : null,
    );
    expect(await refreshMirror(w.project, 'tip-proof', { freshRef: 'main' })).toBeTruthy();
  });
});

test('a shared proof is refused when it is older than the interval, older than an invalidation, or of another tip', async () => {
  const w = await world();
  await refreshMirror(w.project, true);
  const tip = await w.tip();
  await w.away();
  await later(async () => {
    useSharedTipProof(async () => ({ tip, provenAt: Date.now() - 61_000 }));
    await expect(refreshMirror(w.project, 'tip-proof', { freshRef: 'main' })).rejects.toThrow();

    useSharedTipProof(async () => ({ tip: 'f'.repeat(40), provenAt: Date.now() - 1_000 }));
    await expect(refreshMirror(w.project, 'tip-proof', { freshRef: 'main' })).rejects.toThrow();

    const provenAt = Date.now() - 1_000;
    useSharedTipProof(async () => ({ tip, provenAt }));
    invalidateProjectMirror(w.project.projectId);
    await expect(refreshMirror(w.project, 'tip-proof', { freshRef: 'main' })).rejects.toThrow();
  });
});

test('a branch the remote lacks is remembered for one interval; a session push forgets it', async () => {
  const w = await world();
  const session = crypto.randomUUID();
  expect(await mirrorHoldsBranch(w.project, session)).toBe(false);

  // Remembered: no fetch, so it answers while the remote is away.
  await w.away();
  expect(await mirrorHoldsBranch(w.project, session)).toBe(false);
  await w.back();

  await w.commit('session work');
  await w.git('-C', w.work, 'push', w.remote, `HEAD:refs/heads/${session}`);
  noteSessionBranchPushed(w.project.projectId);
  expect(await mirrorHoldsBranch(w.project, session)).toBe(true);
});

test('a branch pushed since the last fetch counts at once', async () => {
  const w = await world();
  await refreshMirror(w.project, true);
  const session = crypto.randomUUID();
  await w.commit('session work');
  await w.git('-C', w.work, 'push', w.remote, `HEAD:refs/heads/${session}`);
  expect(await mirrorHoldsBranch(w.project, session)).toBe(true);
});
