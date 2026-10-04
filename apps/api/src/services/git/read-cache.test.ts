import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { cachedGitRead, clearGitReadCacheForTests, gitReadCacheStats, resolveRefSha } from './read-cache';

const exec = promisify(execFile);

let root = '';
let bare = '';
let work = '';

async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await exec('git', args, { cwd });
  return stdout.trim();
}

async function commit(file: string, content: string): Promise<string> {
  await writeFile(join(work, file), content);
  await git(['add', file], work);
  await git(['commit', '-q', '-m', content], work);
  await git(['push', '-q', 'origin', 'HEAD:refs/heads/main'], work);
  return git(['rev-parse', 'HEAD'], work);
}

beforeEach(async () => {
  clearGitReadCacheForTests();
  root = await mkdtemp(join(tmpdir(), 'kortix-read-cache-'));
  bare = join(root, 'mirror.git');
  work = join(root, 'work');
  await git(['init', '-q', '--bare', bare]);
  await mkdir(work);
  await git(['init', '-q', '--initial-branch=main', work]);
  await git(['config', 'user.name', 'Kortix Test'], work);
  await git(['config', 'user.email', 'test@kortix.invalid'], work);
  await git(['remote', 'add', 'origin', bare], work);
  await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], bare);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('resolveRefSha', () => {
  test('reads a loose branch ref, a packed ref, HEAD, and a full sha without spawning git', async () => {
    const sha = await commit('a.txt', 'one');

    expect(await resolveRefSha(bare, 'main')).toBe(sha);
    expect(await resolveRefSha(bare, 'refs/heads/main')).toBe(sha);
    expect(await resolveRefSha(bare, 'HEAD')).toBe(sha);
    expect(await resolveRefSha(bare, sha)).toBe(sha);

    await git(['pack-refs', '--all', '--prune'], bare);
    expect(await resolveRefSha(bare, 'main')).toBe(sha);
    expect(gitReadCacheStats().refFallbacks).toBe(0);
  });

  test('sees a ref that moved, including an update-ref inside the mirror', async () => {
    const first = await commit('a.txt', 'one');
    const second = await commit('a.txt', 'two');
    expect(await resolveRefSha(bare, 'main')).toBe(second);

    await git(['update-ref', 'refs/heads/main', first], bare);
    expect(await resolveRefSha(bare, 'main')).toBe(first);
  });

  test('falls back to git for a ref it cannot read from disk, and answers null for none', async () => {
    const sha = await commit('a.txt', 'one');

    expect(await resolveRefSha(bare, sha.slice(0, 10))).toBe(sha);
    expect(await resolveRefSha(bare, 'no-such-branch')).toBeNull();
  });
});

describe('cachedGitRead', () => {
  test('runs a read once per commit and again after the ref moves', async () => {
    await commit('a.txt', 'one');
    let runs = 0;
    const read = async () => {
      const sha = await resolveRefSha(bare, 'main');
      return cachedGitRead(bare, sha!, 'show', 'a.txt', async () => {
        runs += 1;
        return git(['show', `${sha}:a.txt`], bare);
      });
    };

    expect(await read()).toBe('one');
    expect(await read()).toBe('one');
    expect(runs).toBe(1);

    await commit('a.txt', 'two');
    expect(await read()).toBe('two');
    expect(runs).toBe(2);
  });

  test('shares one in-flight read and never caches a failure', async () => {
    const sha = await commit('a.txt', 'one');
    let runs = 0;
    const flaky = async () => {
      runs += 1;
      if (runs === 1) throw new Error('transient');
      return 'ok';
    };

    await expect(cachedGitRead(bare, sha, 'show', 'x', flaky)).rejects.toThrow('transient');
    const [a, b] = await Promise.all([
      cachedGitRead(bare, sha, 'show', 'x', flaky),
      cachedGitRead(bare, sha, 'show', 'x', flaky),
    ]);

    expect([a, b]).toEqual(['ok', 'ok']);
    expect(runs).toBe(2);
  });

  test('keys by mirror, commit, operation and argument', async () => {
    const sha = await commit('a.txt', 'one');
    const seen: string[] = [];
    const run = (tag: string) => async () => {
      seen.push(tag);
      return tag;
    };

    await cachedGitRead(bare, sha, 'show', 'a.txt', run('1'));
    await cachedGitRead(bare, sha, 'show', 'b.txt', run('2'));
    await cachedGitRead(bare, sha, 'ls-tree', 'a.txt', run('3'));
    await cachedGitRead(`${bare}-other`, sha, 'show', 'a.txt', run('4'));
    await cachedGitRead(bare, sha, 'show', 'a.txt', run('5'));

    expect(seen).toEqual(['1', '2', '3', '4']);
  });
});
