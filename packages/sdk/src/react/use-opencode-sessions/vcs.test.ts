import { describe, expect, test, beforeEach, mock } from 'bun:test';

// Bound BEFORE `mock.module` runs (static imports execute first), so the mock
// can re-export the REAL `opencodeKeys` while replacing only the two hooks the
// module under test cannot call outside a React render.
import * as realKeys from './keys';

let runtimeReady = true;
mock.module('./keys', () => ({
  ...realKeys,
  useOpenCodeRuntimeReady: () => runtimeReady,
}));

// `useCurrentRuntime` is `useSyncExternalStore` — an invalid hook call outside
// a render. Replace it with a plain selector over a per-test state object.
let runtimeState: { sandboxId: string | null } = { sandboxId: null };
mock.module('../use-current-runtime', () => ({
  useCurrentRuntime: (selector: (s: typeof runtimeState) => unknown) => selector(runtimeState),
}));

// `useQuery` collapses to identity, so the hook can be called as a plain
// function and its config asserted directly — same harness as ./sessions.test.ts.
mock.module('@tanstack/react-query', () => ({
  useQuery: (config: Record<string, unknown>) => config,
}));

let clientImpl: Record<string, unknown> = {};
mock.module('../../core/runtime/client', () => ({
  getClient: () => clientImpl,
}));

const { useOpenCodeVcsDiff } = await import('./vcs');
const { opencodeKeys } = await import('./keys');

type QueryConfig = {
  queryKey: readonly unknown[];
  queryFn: () => Promise<unknown>;
  enabled: boolean;
};

beforeEach(() => {
  runtimeReady = true;
  runtimeState = { sandboxId: 'sbx_1' };
  clientImpl = {};
});

/** Records what `client.vcs.diff()` was called with and answers with `body`. */
function vcsClient(body: unknown | (() => unknown)) {
  const calls: unknown[] = [];
  return {
    calls,
    impl: {
      vcs: {
        diff: async (args: unknown) => {
          calls.push(args);
          return typeof body === 'function' ? (body as () => unknown)() : { data: body };
        },
      },
    },
  };
}

describe('useOpenCodeVcsDiff', () => {
  test('defaults to branch mode — the version-vs-base set, not just the working tree', async () => {
    const { calls, impl } = vcsClient([]);
    clientImpl = impl;
    const config = useOpenCodeVcsDiff() as unknown as QueryConfig;

    await config.queryFn();

    expect(calls).toEqual([{ mode: 'branch' }]);
  });

  test('asks /vcs/diff for the requested mode and returns the file array', async () => {
    const diffs = [
      {
        file: 'src/a.ts',
        patch: 'diff --git a/src/a.ts b/src/a.ts\n',
        additions: 3,
        deletions: 1,
        status: 'modified' as const,
      },
    ];
    const { calls, impl } = vcsClient(diffs);
    clientImpl = impl;
    const config = useOpenCodeVcsDiff('git') as unknown as QueryConfig;

    const result = await config.queryFn();

    expect(calls).toEqual([{ mode: 'git' }]);
    expect(result).toEqual(diffs);
  });

  test('the query key carries the mode and the active sandbox id', () => {
    runtimeState = { sandboxId: 'sbx_9' };
    const branch = useOpenCodeVcsDiff('branch') as unknown as QueryConfig;
    const git = useOpenCodeVcsDiff('git') as unknown as QueryConfig;

    expect(branch.queryKey).toEqual(opencodeKeys.vcsDiff('branch', 'sbx_9'));
    expect(branch.queryKey).toEqual(['opencode', 'vcs-diff', 'branch', 'sbx_9']);
    // Two modes are two different answers — they must never share a cache entry.
    expect(git.queryKey).not.toEqual(branch.queryKey);
    // …and both sit under the prefix the event stream invalidates.
    expect(branch.queryKey.slice(0, 2)).toEqual([...opencodeKeys.vcsDiffAll()]);
  });

  test('the same mode on the same sandbox produces one key, so every reader dedupes', () => {
    const a = useOpenCodeVcsDiff('branch') as unknown as QueryConfig;
    const b = useOpenCodeVcsDiff('branch') as unknown as QueryConfig;
    expect(a.queryKey).toEqual(b.queryKey);
  });

  test('a non-array body becomes an empty array, never undefined', async () => {
    clientImpl = vcsClient(null).impl;
    const config = useOpenCodeVcsDiff('branch') as unknown as QueryConfig;
    expect(await config.queryFn()).toEqual([]);
  });

  test('an SDK error is thrown, so the panel renders its error state instead of "no changes"', async () => {
    clientImpl = vcsClient(() => ({ error: { data: { message: 'not a git repository' } } })).impl;
    const config = useOpenCodeVcsDiff('branch') as unknown as QueryConfig;

    expect(config.queryFn()).rejects.toThrow('not a git repository');
  });

  test('disabled until the runtime is ready', () => {
    runtimeReady = false;
    expect((useOpenCodeVcsDiff('branch') as unknown as QueryConfig).enabled).toBe(false);
    runtimeReady = true;
    expect((useOpenCodeVcsDiff('branch') as unknown as QueryConfig).enabled).toBe(true);
  });

  test('options.enabled === false disables it even when the runtime is ready', () => {
    const config = useOpenCodeVcsDiff('branch', { enabled: false }) as unknown as QueryConfig;
    expect(config.enabled).toBe(false);
  });
});
