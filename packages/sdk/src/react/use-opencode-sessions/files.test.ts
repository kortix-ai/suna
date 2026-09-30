import { describe, expect, test, beforeEach, mock } from 'bun:test';

// `findRuntimeFiles` resolves `getClient()` fresh on every call — swap the
// implementation per-test via `clientImpl` to control exactly what
// `client.find.files()` / `client.file.list()` resolve to.
let clientImpl: {
  find: { files: (args: { query: string; type?: string; limit: number }) => Promise<{ data?: unknown }> };
  file: { list: (args: { path: string }) => Promise<{ data?: unknown }> };
};

mock.module('../../core/runtime/client', () => ({
  getClient: () => clientImpl,
}));

const { findRuntimeFiles } = await import('./files');

/**
 * `findRuntimeFiles` keeps a couple of module-level caches
 * (`mentionFileIndexCache`, `mentionDirScanCache`) that persist across calls
 * within this process and aren't exported for a test to reset. To keep tests
 * independent without fighting that cache:
 *
 *  - Every fixture below responds to the REAL query with its matches, but
 *    returns an EMPTY list for `query: ''` (the broad-index-building calls
 *    the "file index" fallback makes) — so that fallback always populates
 *    its cache with nothing, never leaking one test's fixture into another.
 *  - `file.list` defaults to empty for every path unless a test explicitly
 *    wants to exercise the directory-expansion path, so the (also-cached)
 *    root/directory-scan fallbacks always contribute nothing either.
 */
function queryAwareFiles(matches: unknown[]) {
  return async ({ query }: { query: string }) => ({ data: query === '' ? [] : matches });
}

beforeEach(() => {
  clientImpl = {
    find: { files: async () => ({ data: [] }) },
    file: { list: async () => ({ data: [] }) },
  };
});

describe('findRuntimeFiles — ranking and dedup', () => {
  test('ranks an exact basename match first, then prefix, then substring, then path-substring', async () => {
    // `find.files({ query })` is trusted as already server-filtered — this
    // function's own job is ranking what comes back, not re-filtering it
    // (client-side relevance filtering only happens in the fallback paths,
    // covered separately below), so every fixture entry here is a genuine
    // "app" match at a different rank tier.
    clientImpl.find.files = queryAwareFiles([
      'src/components/app.tsx', // substring: "app" inside "app.tsx" AND path
      'src/app-config.ts', // prefix: basename starts with "app"
      'app.ts', // exact basename match
      'app-folder/utils.ts', // path-substring only (directory name, not basename)
    ]);

    const results = await findRuntimeFiles('app');
    expect(results).toHaveLength(4);
    // Exact basename match ranks above a prefix match, which ranks above a
    // substring-only match, which ranks above a path-only substring match.
    expect(results.indexOf('app.ts')).toBeLessThan(results.indexOf('src/app-config.ts'));
    expect(results.indexOf('src/app-config.ts')).toBeLessThan(results.indexOf('src/components/app.tsx'));
    expect(results.indexOf('src/components/app.tsx')).toBeLessThan(results.indexOf('app-folder/utils.ts'));
  });

  test('dedups identical paths returned by both the strict and broad query', async () => {
    let callCount = 0;
    clientImpl.find.files = async ({ query }) => {
      if (query === '') return { data: [] };
      callCount++;
      return { data: ['src/app.ts'] };
    };

    const results = await findRuntimeFiles('app');
    expect(callCount).toBe(2); // strict + broad, each returning the same path
    expect(results).toEqual(['src/app.ts']);
  });

  test('an empty query still ranks by directory depth (shallower first)', async () => {
    // The query itself is '' here (matches everything), which is also what
    // the file-index fallback's own background calls use — give it the same
    // fixture; the assertion only cares about the top 20, so extra identical
    // entries are harmless.
    clientImpl.find.files = async () => ({ data: ['a/b/c/deep.ts', 'top.ts', 'a/mid.ts'] });

    const results = await findRuntimeFiles('');
    expect(results).toEqual(['top.ts', 'a/mid.ts', 'a/b/c/deep.ts']);
  });

  test('object-shaped entries with a `path`/`type` field are normalized (directories get a trailing slash)', async () => {
    clientImpl.find.files = queryAwareFiles([
      { path: 'src/app.ts', type: 'file' },
      { path: 'src/nested', type: 'directory' },
    ]);

    const results = await findRuntimeFiles('app');
    expect(results).toEqual(['src/app.ts']);
    // The directory entry is never returned as a file match (only used
    // internally to seed the directory-expansion fallback).
    expect(results).not.toContain('src/nested');
    expect(results).not.toContain('src/nested/');
  });

  test('results are capped at 20 entries', async () => {
    const many = Array.from({ length: 30 }, (_, i) => `file${String(i).padStart(2, '0')}.ts`);
    clientImpl.find.files = queryAwareFiles(many);

    const results = await findRuntimeFiles('file');
    expect(results).toHaveLength(20);
  });

  test('a malformed/rejecting find.files() response is treated as no matches, not a throw', async () => {
    clientImpl.find.files = async () => {
      throw new Error('network down');
    };
    await expect(findRuntimeFiles('anything')).resolves.toEqual([]);
  });
});

describe('findRuntimeFiles — directory-expansion fallback', () => {
  test('expands a matched directory into its children when strict/broad matches are sparse', async () => {
    clientImpl.find.files = async ({ type, query }) => {
      if (query === '' || type === 'file') return { data: [] };
      // Broad query returns only a directory match.
      return { data: [{ path: 'src/utils', type: 'directory' }] };
    };
    // Sparse (<20) results also trigger the root-scan and dir-scan fallbacks
    // (both call `file.list` with paths other than the expanded directory,
    // e.g. `/workspace`/`''`) — return that directory's children only for
    // its own path, and an empty listing for everything else.
    clientImpl.file.list = async ({ path }) => {
      if (path === 'src/utils') return { data: ['src/utils/app-helpers.ts', 'src/utils/other.ts'] };
      return { data: [] };
    };

    const results = await findRuntimeFiles('app');
    expect(results).toContain('src/utils/app-helpers.ts');
    expect(results).not.toContain('src/utils/other.ts'); // doesn't match the query "app"
  });
});
