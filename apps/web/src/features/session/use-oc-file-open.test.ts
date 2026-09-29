import { beforeEach, describe, expect, mock, test } from 'bun:test';

/**
 * Characterization tests for the module-level prefix cache behind
 * `resolveRuntimePath` — the `discoverPrefixViaFileApi` fallback that probes
 * the file API with progressively longer suffixes and remembers what worked.
 *
 * The cache lives in module state, so each test keeps to its own path roots
 * and asserts on its own reads; no scenario borrows another's cache.
 *
 * The collaborators are injected here, not faked in place: apps/web's test
 * script runs `bun test --isolate`, so this file's mock registry stays inside
 * its own process and never leaks into a sibling suite.
 */

const reads: string[] = [];

let served: (path: string) => Promise<string> = async () => {
  throw new Error('no probe reply configured');
};

mock.module('@/features/files/api/runtime-file-read', () => ({
  readRuntimeFileWithRetry: (
    _filePath: string,
    read: (signal?: AbortSignal) => Promise<unknown>,
  ) => read(),
}));

mock.module('@kortix/sdk/react', () => ({
  runtimeKeys: {
    currentProject: () => ['opencode', 'project', 'current', 'test'] as const,
    pathInfo: () => ['opencode', 'path-info', 'test'] as const,
  },
  // `resolveRuntimePath` passes no query client, so the SDK fallback runs;
  // it is offline here by construction.
  getRuntimeProjectInfo: async () => {
    throw new Error('sdk offline in tests');
  },
  getRuntimePathInfo: async () => {
    throw new Error('sdk offline in tests');
  },
  readRuntimeTextFile: async (path: string) => {
    reads.push(path);
    return served(path);
  },
}));

const { resolveRuntimePath } = await import('./use-oc-file-open');

beforeEach(() => {
  reads.length = 0;
  served = async () => {
    throw new Error('no probe reply configured');
  };
});

describe('resolveRuntimePath prefix cache', () => {
  test('a relative path is returned unchanged without touching the cache', async () => {
    expect(await resolveRuntimePath('src/app.ts')).toBe('src/app.ts');
    expect(reads).toEqual([]);
  });

  test('a single-segment absolute path bails out before any probe', async () => {
    expect(await resolveRuntimePath('/only-file.ts')).toBe('/only-file.ts');
    expect(reads).toEqual([]);
  });

  test('every probe fails → the absolute path is returned unchanged', async () => {
    const abs = '/probe-fail-root/a/b/file.ts';
    expect(await resolveRuntimePath(abs)).toBe(abs);
    // Starts from the filename and adds parents: depths 1, 2, 3 for a
    // 4-segment path (maxDepth = min(segments - 1, 8)).
    expect(reads).toEqual(['file.ts', 'b/file.ts', 'a/b/file.ts']);
  });

  test('a probe succeeds at depth n → the suffix is returned and the prefix is cached', async () => {
    served = async (path) => {
      if (path === 'src/foo.txt') return 'contents';
      throw new Error('ENOENT');
    };
    expect(await resolveRuntimePath('/probe-success-root/repo/src/foo.txt')).toBe(
      'src/foo.txt',
    );
    expect(reads).toEqual(['foo.txt', 'src/foo.txt']);

    // The discovered prefix is cached: a sibling path resolves without a probe.
    expect(await resolveRuntimePath('/probe-success-root/repo/other.md')).toBe('other.md');
    expect(reads).toEqual(['foo.txt', 'src/foo.txt']);
  });

  test('a new discovery merges into the cache instead of clobbering it', async () => {
    served = async (path) => {
      if (path === 'leaf.ts') return 'contents';
      throw new Error('ENOENT');
    };
    // First discovery caches /merge-root/proj.
    expect(await resolveRuntimePath('/merge-root/proj/leaf.ts')).toBe('leaf.ts');
    expect(reads).toEqual(['leaf.ts']);
    // The second path does not match the first prefix, so it probes again and
    // caches /merge-root/proj-longer beside it.
    expect(await resolveRuntimePath('/merge-root/proj-longer/leaf.ts')).toBe('leaf.ts');
    expect(reads).toEqual(['leaf.ts', 'leaf.ts']);
    // Both prefixes are alive: neither discovery clobbers the other.
    expect(await resolveRuntimePath('/merge-root/proj/other.md')).toBe('other.md');
    expect(await resolveRuntimePath('/merge-root/proj-longer/other.md')).toBe('other.md');
    expect(reads).toEqual(['leaf.ts', 'leaf.ts']);
  });

  test('an empty read is not a success — probing continues to longer suffixes', async () => {
    served = async (path) => {
      if (path === 'empty.md') return '';
      if (path === 'docs/empty.md') return 'contents';
      throw new Error('ENOENT');
    };
    expect(await resolveRuntimePath('/empty-root/docs/empty.md')).toBe('docs/empty.md');
    expect(reads).toEqual(['empty.md', 'docs/empty.md']);
  });
});
