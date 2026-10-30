import { describe, expect, test, beforeEach, mock } from 'bun:test';

// Bound BEFORE `mock.module` runs (static imports execute first), so the mock
// can re-export the REAL `runtimeKeys` while replacing only the two hooks the
// module under test cannot call outside a React render.
import * as realKeys from './keys';

let runtimeReady = true;
mock.module('./keys', () => ({
  ...realKeys,
  useRuntimeReady: () => runtimeReady,
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

// The session-log action route of the active runtime: null = an older box (the default here).
let actionImpl: (method: string, path: string) => Promise<Response | null> = async () => null;
const actionCalls: unknown[] = [];
const realRuntimeActions = await import('../../core/session/runtime-actions');
mock.module('../../core/session/runtime-actions', () => ({
  ...realRuntimeActions,
  activeRuntimeAction: (method: string, path: string) => (actionCalls.push([method, path]), actionImpl(method, path)),
}));

const { useRuntimeVcsDiff, useRuntimeWorkspace } = await import('./vcs');
const { runtimeKeys } = await import('./keys');

type QueryConfig = {
  queryKey: readonly unknown[];
  queryFn: () => Promise<unknown>;
  enabled: boolean;
};

beforeEach(() => {
  runtimeReady = true;
  runtimeState = { sandboxId: 'sbx_1' };
  clientImpl = {};
  actionImpl = async () => null;
  actionCalls.length = 0;
});

describe('on a box with the session-log actions', () => {
  test('the diff is the workspace diff route, keyed by path', async () => {
    actionImpl = async () =>
      Response.json({ files: [{ path: 'src/a.ts', status: 'modified', additions: 3, deletions: 1, patch: '@@' }] });
    const result = await (useRuntimeVcsDiff('git') as unknown as QueryConfig).queryFn();
    expect(actionCalls).toEqual([['GET', '/kortix/runtime/workspace/diff?mode=git']]);
    expect(result).toEqual([{ file: 'src/a.ts', status: 'modified', additions: 3, deletions: 1, patch: '@@' }]);
  });

  test('a refused diff throws the runtime message', async () => {
    actionImpl = async () => Response.json({ error: 'not a git repository' }, { status: 500 });
    await expect((useRuntimeVcsDiff('branch') as unknown as QueryConfig).queryFn()).rejects.toThrow('not a git repository');
  });

  test('useRuntimeWorkspace reads the workspace route', async () => {
    const info = { directory: '/workspace/app', home: '/root', vcs: 'git', default_branch: 'main' };
    actionImpl = async () => Response.json(info);
    expect(await (useRuntimeWorkspace() as unknown as QueryConfig).queryFn()).toEqual(info);
  });
});

test('useRuntimeWorkspace on an older box: the path and the current project', async () => {
  clientImpl = {
    path: { get: async () => ({ data: { home: '/root', directory: '/workspace', worktree: '/workspace', state: '', config: '' } }) },
    project: { current: async () => ({ data: { id: 'p', worktree: '/workspace', vcs: 'git', time: { created: 0 }, sandboxes: [] } }) },
  };
  expect(await (useRuntimeWorkspace() as unknown as QueryConfig).queryFn()).toEqual({
    directory: '/workspace',
    home: '/root',
    vcs: 'git',
    default_branch: null,
  });
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

describe('useRuntimeVcsDiff', () => {
  test('defaults to branch mode — the version-vs-base set, not just the working tree', async () => {
    const { calls, impl } = vcsClient([]);
    clientImpl = impl;
    const config = useRuntimeVcsDiff() as unknown as QueryConfig;

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
    const config = useRuntimeVcsDiff('git') as unknown as QueryConfig;

    const result = await config.queryFn();

    expect(calls).toEqual([{ mode: 'git' }]);
    expect(result).toEqual(diffs);
  });

  test('the query key carries the mode and the active sandbox id', () => {
    runtimeState = { sandboxId: 'sbx_9' };
    const branch = useRuntimeVcsDiff('branch') as unknown as QueryConfig;
    const git = useRuntimeVcsDiff('git') as unknown as QueryConfig;

    expect(branch.queryKey).toEqual(runtimeKeys.vcsDiff('branch', 'sbx_9'));
    expect(branch.queryKey).toEqual(['opencode', 'vcs-diff', 'branch', 'sbx_9']);
    // Two modes are two different answers — they must never share a cache entry.
    expect(git.queryKey).not.toEqual(branch.queryKey);
    // …and both sit under the prefix the event stream invalidates.
    expect(branch.queryKey.slice(0, 2)).toEqual([...runtimeKeys.vcsDiffAll()]);
  });

  test('the same mode on the same sandbox produces one key, so every reader dedupes', () => {
    const a = useRuntimeVcsDiff('branch') as unknown as QueryConfig;
    const b = useRuntimeVcsDiff('branch') as unknown as QueryConfig;
    expect(a.queryKey).toEqual(b.queryKey);
  });

  test('a non-array body becomes an empty array, never undefined', async () => {
    clientImpl = vcsClient(null).impl;
    const config = useRuntimeVcsDiff('branch') as unknown as QueryConfig;
    expect(await config.queryFn()).toEqual([]);
  });

  test('an SDK error is thrown, so the panel renders its error state instead of "no changes"', async () => {
    clientImpl = vcsClient(() => ({ error: { data: { message: 'not a git repository' } } })).impl;
    const config = useRuntimeVcsDiff('branch') as unknown as QueryConfig;

    expect(config.queryFn()).rejects.toThrow('not a git repository');
  });

  test('disabled until the runtime is ready', () => {
    runtimeReady = false;
    expect((useRuntimeVcsDiff('branch') as unknown as QueryConfig).enabled).toBe(false);
    runtimeReady = true;
    expect((useRuntimeVcsDiff('branch') as unknown as QueryConfig).enabled).toBe(true);
  });

  test('options.enabled === false disables it even when the runtime is ready', () => {
    const config = useRuntimeVcsDiff('branch', { enabled: false }) as unknown as QueryConfig;
    expect(config.enabled).toBe(false);
  });
});
