import { afterEach, expect, spyOn, test } from 'bun:test';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { invalidateProjectMirror, refreshMirror } from './mirror';

const exec = promisify(execFile);
const previousCache = process.env.KORTIX_GIT_CACHE_DIR;
let root = '';
afterEach(async () => {
  if (previousCache === undefined) delete process.env.KORTIX_GIT_CACHE_DIR;
  else process.env.KORTIX_GIT_CACHE_DIR = previousCache;
  if (root) await fs.rm(root, { recursive: true, force: true });
});

test('a session read joining an invalidated refresh observes the newly merged agent', async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'kortix-mirror-flight-'));
  process.env.KORTIX_GIT_CACHE_DIR = join(root, 'cache');
  const remote = join(root, 'remote.git');
  const work = join(root, 'work');
  const git = async (...args: string[]) => (await exec('git', args)).stdout.trim();
  await git('init', '--bare', '--initial-branch=main', remote);
  await git('init', '--initial-branch=main', work);
  await git('-C', work, '-c', 'user.name=Test', '-c', 'user.email=agent@kortix.ai', 'commit', '--allow-empty', '-m', 'seed');
  await git('-C', work, 'push', remote, 'main');
  const project = { projectId: crypto.randomUUID(), repoUrl: remote, defaultBranch: 'main', manifestPath: 'kortix.yaml', gitAuthToken: 'synthetic' };
  const mirror = await refreshMirror(project, true);
  let entered = () => {};
  let release = () => {};
  const paused = new Promise<void>((resolve) => { entered = resolve; });
  const resume = new Promise<void>((resolve) => { release = resolve; });
  const original = fs.utimes;
  let first = true;
  const touch = spyOn(fs, 'utimes').mockImplementation(async (...args) => {
    if (first && args[0] === mirror) {
      first = false;
      entered();
      await resume;
    }
    return original(...args);
  });
  try {
    const inFlight = refreshMirror(project, true);
    await paused;
    await fs.mkdir(join(work, 'agents'));
    await fs.writeFile(join(work, 'agents', 'helper.md'), 'New agent instructions');
    await git('-C', work, 'add', 'agents/helper.md');
    await git('-C', work, '-c', 'user.name=Test', '-c', 'user.email=agent@kortix.ai', 'commit', '-m', 'add agent');
    await git('-C', work, 'push', remote, 'main');
    invalidateProjectMirror(project.projectId);
    const session = refreshMirror(project, 'tip-proof', { freshRef: 'main' });
    release();
    await inFlight;
    const checkout = await session;
    expect(await git('-C', checkout, 'show', 'main:agents/helper.md')).toBe('New agent instructions');
  } finally {
    release();
    touch.mockRestore();
  }
});
