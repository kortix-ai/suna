/**
 * The extracted-snapshot cache has to forget things.
 *
 * It is content-addressed, so every revision of every project adds a tree and
 * nothing replaced one — an API host filled its disk in proportion to how many
 * revisions it had ever served. Eviction is by last use, and must never take an
 * entry a session is about to read.
 *
 * Run:
 *   cd apps/api && bun test --isolate src/repo-snapshots/cache-eviction.test.ts
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

let root = '';

function seed(repositoryId: string, commitSha: string, digest: string, ageMs: number): string {
  const path = join(root, repositoryId, commitSha, digest);
  mkdirSync(join(path, '.git'), { recursive: true });
  writeFileSync(join(path, '.git', 'kortix-project-snapshot.json'), '{}');
  const at = new Date(Date.now() - ageMs);
  utimesSync(path, at, at);
  return path;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kortix-cache-evict-'));
  process.env.KORTIX_REPO_SNAPSHOT_CACHE_DIR = root;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.KORTIX_REPO_SNAPSHOT_CACHE_DIR;
});

describe('pruneSnapshotCache', () => {
  test('drops what nobody has used in a long time', async () => {
    const { pruneSnapshotCache } = await import('./source-reader');
    const cold = seed('100', 'a'.repeat(40), 'd1', 24 * 60 * 60_000);
    const warm = seed('100', 'b'.repeat(40), 'd2', 60_000);

    expect(await pruneSnapshotCache()).toBe(1);
    expect(existsSync(cold)).toBe(false);
    expect(existsSync(warm)).toBe(true);
  });

  test('never evicts a freshly materialized tree, whatever the pressure', async () => {
    const { pruneSnapshotCache } = await import('./source-reader');
    process.env.KORTIX_REPO_SNAPSHOT_CACHE_MAX_ENTRIES = '1';
    const paths = Array.from({ length: 5 }, (_, index) =>
      // Every one of them seconds old: this is the boot-storm shape, five
      // sessions materializing at once. Evicting any of them would delete a
      // tree another session is reading right now.
      seed('200', String(index).repeat(40), `d${index}`, 5_000),
    );
    try {
      expect(await pruneSnapshotCache()).toBe(0);
    } finally {
      delete process.env.KORTIX_REPO_SNAPSHOT_CACHE_MAX_ENTRIES;
    }
    for (const path of paths) expect(existsSync(path)).toBe(true);
  });

  test('trims the oldest first when there are too many', async () => {
    const { pruneSnapshotCache } = await import('./source-reader');
    // Six entries, all past the minimum age, none past the TTL, cap of 2.
    const ages = [60, 50, 40, 30, 20, 15].map((minutes) => minutes * 60_000);
    const paths = ages.map((age, index) => seed('300', String(index).repeat(40), `d${index}`, age));
    process.env.KORTIX_REPO_SNAPSHOT_CACHE_MAX_ENTRIES = '2';
    try {
      expect(await pruneSnapshotCache()).toBe(4);
    } finally {
      delete process.env.KORTIX_REPO_SNAPSHOT_CACHE_MAX_ENTRIES;
    }
    // The four least recently used are gone; the two newest remain.
    expect(paths.slice(0, 4).map((path) => existsSync(path))).toEqual([false, false, false, false]);
    expect(paths.slice(4).map((path) => existsSync(path))).toEqual([true, true]);
  });

  test('a read that starts during a prune keeps its tree', async () => {
    const { pruneSnapshotCache } = await import('./source-reader');
    const path = seed('400', 'c'.repeat(40), 'd1', 24 * 60 * 60_000);

    // The scan is already several seconds old when the reader arrives: it
    // renews the lease (as every cached read does) and starts working inside
    // the tree. The prune must notice and leave it alone.
    const touched = new Date();
    const prune = pruneSnapshotCache(Date.now()).then(async (removed) => {
      return removed;
    });
    utimesSync(path, touched, touched);
    expect(await prune).toBe(0);
    expect(existsSync(path)).toBe(true);
  });

  test('a missing cache directory is not an error', async () => {
    const { pruneSnapshotCache } = await import('./source-reader');
    process.env.KORTIX_REPO_SNAPSHOT_CACHE_DIR = join(root, 'does-not-exist');
    expect(await pruneSnapshotCache()).toBe(0);
  });
});
