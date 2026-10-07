import { describe, expect, test } from 'bun:test';
import type { FastBootGitHint } from '../git/fast-boot-bundle';
import type { GitBackedProject } from '../git/types';
import {
  buildCachedFastBootGitHint,
  readCachedFastBootGitHint,
  resolveFastBootGitHintWithCache,
} from './fast-boot-git-hint';

const project: GitBackedProject = {
  projectId: 'project-1',
  repoUrl: 'https://git.example.com/project-1.git',
  defaultBranch: 'main',
  manifestPath: 'kortix.yaml',
  gitAuthToken: null,
};

const cachedHint: FastBootGitHint = {
  baseSha: 'a'.repeat(40),
  gitDeltaBundleBase64: Buffer.from('bundle').toString('base64'),
  gitDeltaParentSha: 'b'.repeat(40),
  gitDeltaParentCommitBase64: Buffer.from('tree deadbeef\n').toString('base64'),
};

function metadataFor(hint: FastBootGitHint = cachedHint, ref = 'main') {
  return {
    git: {
      fast_boot: buildCachedFastBootGitHint(ref, hint, '2026-08-20T00:00:00.000Z'),
    },
  };
}

describe('fast boot Git hint cache', () => {
  test('reads a bounded cache entry for the requested ref', () => {
    expect(metadataFor().git.fast_boot?.version).toBe(3);
    expect(readCachedFastBootGitHint(metadataFor(), 'main')).toEqual(cachedHint);
    expect(readCachedFastBootGitHint(metadataFor(cachedHint, 'dev'), 'main')).toBeNull();
  });

  test('rejects malformed and oversized cache entries', () => {
    expect(
      readCachedFastBootGitHint(
        metadataFor({ baseSha: 'bad', gitDeltaBundleBase64: cachedHint.gitDeltaBundleBase64 }),
        'main',
      ),
    ).toBeNull();
    expect(
      buildCachedFastBootGitHint('main', {
        baseSha: 'a'.repeat(40),
        gitDeltaBundleBase64: Buffer.alloc(24 * 1024 + 1).toString('base64'),
        gitDeltaParentSha: 'b'.repeat(40),
        gitDeltaParentCommitBase64: Buffer.from('tree deadbeef\n').toString('base64'),
      }),
    ).toBeNull();
    expect(
      buildCachedFastBootGitHint('main', {
        baseSha: 'a'.repeat(40),
        gitDeltaBundleBase64: cachedHint.gitDeltaBundleBase64,
      }),
    ).toBeNull();
  });


  test('round-trips a remote delta', () => {
    const remote: FastBootGitHint = {
      baseSha: 'a'.repeat(40),
      gitDeltaBundleRemote: true,
      gitDeltaParentSha: 'b'.repeat(40),
      gitDeltaParentCommitBase64: Buffer.from('tree deadbeef\n').toString('base64'),
    };
    const entry = metadataFor(remote).git.fast_boot;
    expect(entry?.bundle_remote).toBe(true);
    expect(entry?.bundle_base64).toBe('');
    expect(readCachedFastBootGitHint(metadataFor(remote), 'main')).toEqual(remote);
    // A remote delta must not also carry an inline bundle.
    expect(
      buildCachedFastBootGitHint('main', { ...remote, gitDeltaBundleBase64: 'QUJDRA==' }),
    ).toBeNull();
  });

  test('an entry written before the config-dir hint was removed still reads, without it', () => {
    // The daemon stopped reading KORTIX_OPENCODE_CONFIG_DIR_HINT in #7403 (W3 D3).
    const cached = metadataFor({ baseSha: 'a'.repeat(40) });
    (cached.git.fast_boot as unknown as Record<string, unknown>).opencode_config_dir = '.kortix/opencode';
    expect(readCachedFastBootGitHint(cached, 'main')).toEqual({ baseSha: 'a'.repeat(40) });
  });

  test('reuses a cache entry only when the remote tip still matches', async () => {
    let freshCalls = 0;
    let persistCalls = 0;
    const result = await resolveFastBootGitHintWithCache(project, 'main', metadataFor(), {
      resolveRemoteTip: async () => cachedHint.baseSha,
      resolveFreshHint: async () => {
        freshCalls += 1;
        return cachedHint;
      },
      persistHint: async () => {
        persistCalls += 1;
      },
    });
    expect(result).toEqual(cachedHint);
    expect(freshCalls).toBe(0);
    expect(persistCalls).toBe(0);
  });

  test('force-refreshes and replaces a stale cache entry', async () => {
    const freshHint = {
      baseSha: 'b'.repeat(40),
      gitDeltaBundleBase64: Buffer.from('fresh').toString('base64'),
      gitDeltaParentSha: 'c'.repeat(40),
      gitDeltaParentCommitBase64: Buffer.from('tree cafe\n').toString('base64'),
    };
    const forceRefreshes: boolean[] = [];
    const persisted: FastBootGitHint[] = [];
    const result = await resolveFastBootGitHintWithCache(project, 'main', metadataFor(), {
      resolveRemoteTip: async () => freshHint.baseSha,
      resolveFreshHint: async (_project, _ref, forceRefresh) => {
        forceRefreshes.push(forceRefresh);
        return freshHint;
      },
      persistHint: async (_projectId, _ref, hint) => {
        persisted.push(hint);
      },
    });
    expect(result).toEqual(freshHint);
    expect(forceRefreshes).toEqual([true]);
    expect(persisted).toEqual([freshHint]);
  });

  test('builds without a forced refresh when no cache entry exists', async () => {
    const forceRefreshes: boolean[] = [];
    await resolveFastBootGitHintWithCache(project, 'main', null, {
      resolveRemoteTip: async () => null,
      resolveFreshHint: async (_project, _ref, forceRefresh) => {
        forceRefreshes.push(forceRefresh);
        return cachedHint;
      },
      persistHint: async () => {},
    });
    expect(forceRefreshes).toEqual([false]);
  });
});
