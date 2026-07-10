import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reapGitCacheOverBudget } from './mirror';

const MB = 1024 * 1024;

let cacheDir: string;
let previousEnv: string | undefined;

async function makeMirror(name: string, bytes: number, ageMinutes: number): Promise<string> {
  const dir = join(cacheDir, `${name}.git`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'pack'), Buffer.alloc(bytes));
  const when = new Date(Date.now() - ageMinutes * 60_000);
  await utimes(join(dir, 'pack'), when, when);
  await utimes(dir, when, when);
  return dir;
}

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'reaper-test-'));
  previousEnv = process.env.KORTIX_GIT_CACHE_DIR;
  process.env.KORTIX_GIT_CACHE_DIR = cacheDir;
});

afterEach(async () => {
  if (previousEnv === undefined) delete process.env.KORTIX_GIT_CACHE_DIR;
  else process.env.KORTIX_GIT_CACHE_DIR = previousEnv;
  await rm(cacheDir, { recursive: true, force: true });
});

describe('reapGitCacheOverBudget', () => {
  test('leaves everything alone under budget', async () => {
    const a = await makeMirror('aaa', 1 * MB, 60);
    const b = await makeMirror('bbb', 1 * MB, 30);
    const result = await reapGitCacheOverBudget(10 * MB);
    expect(result.deleted).toBe(0);
    expect(existsSync(a)).toBe(true);
    expect(existsSync(b)).toBe(true);
  });

  test('evicts least-recently-used mirrors first until under budget', async () => {
    const oldest = await makeMirror('oldest', 3 * MB, 120);
    const middle = await makeMirror('middle', 3 * MB, 60);
    const newest = await makeMirror('newest', 3 * MB, 20);
    const result = await reapGitCacheOverBudget(7 * MB);
    expect(result.deleted).toBe(1);
    expect(existsSync(oldest)).toBe(false);
    expect(existsSync(middle)).toBe(true);
    expect(existsSync(newest)).toBe(true);
    expect(result.totalBytes).toBeLessThanOrEqual(7 * MB);
  });

  test('keeps evicting across multiple mirrors to reach budget', async () => {
    const first = await makeMirror('first', 4 * MB, 180);
    const second = await makeMirror('second', 4 * MB, 90);
    const third = await makeMirror('third', 4 * MB, 30);
    const result = await reapGitCacheOverBudget(5 * MB);
    expect(result.deleted).toBe(2);
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(false);
    expect(existsSync(third)).toBe(true);
  });

  test('never evicts mirrors inside the grace window even over budget', async () => {
    const recent = await makeMirror('recent', 8 * MB, 1);
    const result = await reapGitCacheOverBudget(2 * MB);
    expect(result.deleted).toBe(0);
    expect(existsSync(recent)).toBe(true);
  });

  test('ignores non-mirror entries in the cache root', async () => {
    await writeFile(join(cacheDir, 'stray-file'), Buffer.alloc(4 * MB));
    const mirror = await makeMirror('real', 1 * MB, 60);
    const result = await reapGitCacheOverBudget(10 * MB);
    expect(result.deleted).toBe(0);
    expect(existsSync(mirror)).toBe(true);
    expect(existsSync(join(cacheDir, 'stray-file'))).toBe(true);
  });

  test('missing cache root is a no-op', async () => {
    process.env.KORTIX_GIT_CACHE_DIR = join(cacheDir, 'does-not-exist');
    const result = await reapGitCacheOverBudget(1 * MB);
    expect(result).toEqual({ totalBytes: 0, deleted: 0, freedBytes: 0 });
  });
});
