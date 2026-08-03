import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as mirror from './mirror';

const realRunGit = mirror.runGit;
let concurrent = 0;
let maxConcurrent = 0;

mock.module('./mirror', () => ({
  ...mirror,
  runGit: async (...args: Parameters<typeof realRunGit>) => {
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise((resolve) => setTimeout(resolve, 5));
    try {
      return await realRunGit(...args);
    } finally {
      concurrent -= 1;
    }
  },
}));

const { hashBlobs } = await import('./branches');

function independentBlobSha(content: string | Uint8Array, repoPath: string): string {
  return execFileSync('git', ['hash-object', '--stdin'], {
    cwd: repoPath,
    input: content,
    encoding: 'utf8' as const,
  }).trim();
}

describe('hashBlobs', () => {
  let repoPath = '';
  let tempDir = '';

  beforeEach(async () => {
    repoPath = await mkdtemp(join(tmpdir(), 'kortix-hash-blobs-repo-'));
    execFileSync('git', ['init', '--bare', repoPath], { encoding: 'utf8' });
    tempDir = await mkdtemp(join(tmpdir(), 'kortix-hash-blobs-tmp-'));
    concurrent = 0;
    maxConcurrent = 0;
  });

  afterEach(async () => {
    if (repoPath) await rm(repoPath, { recursive: true, force: true });
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  test('hashes many files with correct shas in the original input order', async () => {
    const files = Array.from({ length: 20 }, (_, i) => ({
      path: `dir/file-${i}.txt`,
      content: `content for file ${i}\n`,
    }));

    const blobs = await hashBlobs(files, tempDir, repoPath);

    expect(blobs.map((b) => b.path)).toEqual(files.map((f) => f.path));
    for (const [i, blob] of blobs.entries()) {
      expect(blob.sha).toBe(independentBlobSha(files[i].content, repoPath));
      expect(blob.sha).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  test('bounds concurrent hash-object subprocesses at 8', async () => {
    const files = Array.from({ length: 20 }, (_, i) => ({
      path: `file-${i}.txt`,
      content: `payload-${i}\n`,
    }));

    await hashBlobs(files, tempDir, repoPath);

    expect(maxConcurrent).toBeGreaterThan(1);
    expect(maxConcurrent).toBeLessThanOrEqual(8);
  });

  test('produces the same blobs for an empty file list', async () => {
    const blobs = await hashBlobs([], tempDir, repoPath);
    expect(blobs).toEqual([]);
  });

  test('hashes binary bytes exactly and preserves executable modes', async () => {
    const files = [
      {
        path: 'assets/pixel.png',
        content: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]),
        mode: '100644' as const,
      },
      {
        path: 'scripts/check.sh',
        content: new TextEncoder().encode('#!/bin/sh\necho ok\n'),
        mode: '100755' as const,
      },
    ];

    const blobs = await hashBlobs(files, tempDir, repoPath);
    const [assetFile, scriptFile] = files;
    if (!assetFile || !scriptFile) throw new Error('Expected binary hash fixtures');

    expect(blobs).toEqual([
      {
        path: assetFile.path,
        sha: independentBlobSha(assetFile.content, repoPath),
        mode: '100644',
      },
      {
        path: scriptFile.path,
        sha: independentBlobSha(scriptFile.content, repoPath),
        mode: '100755',
      },
    ]);
  });
});
