import type { Session } from '../../core/runtime/runtime-types';
import { qk } from '../query-keys';
import { describe, expect, test, beforeEach, mock } from 'bun:test';
// Imported BEFORE `mock.module` below runs, so this binds to the REAL store
// (module resolution for a static import happens before the rest of this
// file's top-level code executes) — used as the mock's backing state so
// `onMutate`/`onError` assertions see genuine store mutations.
import { useRuntimeCompactionStore as realCompactionStore } from '../../browser/stores/runtime-compaction-store';

// react-query's `useQuery`/`useMutation` are mocked down to identity functions
// (return the config object passed in) so the hooks under test can be called
// as plain functions — same harness as `./messages.test.ts` /
// `../use-kortix-master.test.ts`. `useQueryClient` returns a minimal
// hand-rolled cache (not a real `QueryClient`) with just the methods these
// two hooks actually call.
function makeFakeQueryClient() {
  const cache = new Map<string, unknown>();
  const cacheKey = (k: readonly unknown[]) => JSON.stringify(k);
  const refetchCalls: Array<{ queryKey?: readonly unknown[]; predicate?: (query: { queryKey: readonly unknown[] }) => boolean }> = [];
  return {
    setQueryData: (k: readonly unknown[], updater: unknown) => {
      const existing = cache.get(cacheKey(k));
      const value =
        typeof updater === 'function' ? (updater as (old: unknown) => unknown)(existing) : updater;
      cache.set(cacheKey(k), value);
      return value;
    },
    getQueryData: (k: readonly unknown[]) => cache.get(cacheKey(k)),
    refetchQueries: (opts: { queryKey?: readonly unknown[]; predicate?: (query: { queryKey: readonly unknown[] }) => boolean }) => {
      refetchCalls.push(opts);
    },
    refetchCalls,
  };
}

let fakeQueryClient = makeFakeQueryClient();

let mutationSuccess: ((session: Session) => unknown) | undefined;

mock.module('@tanstack/react-query', () => ({
  useQuery: (config: Record<string, unknown>) => config,
  useMutation: (config: { onSuccess?: (session: Session) => unknown }) => {
    mutationSuccess = config.onSuccess;
    return config;
  },
  useQueryClient: () => fakeQueryClient,
}));

// `client` is swapped per-test via `clientImpl` so each test controls exactly
// what `client.session.messages()` / `client.session.summarize()` /
// `client.session.command()` resolve to.
let clientImpl: Record<string, unknown> = {};
mock.module('../../core/runtime/client', () => ({
  getClient: () => clientImpl,
}));

// `useRuntimeCompactionStore` is a real zustand hook — calling it outside a
// React render (as this file does, invoking hooks as plain functions) throws
// "Invalid hook call". Replace the reactive wrapper with a plain selector
// call against the REAL store's `getState()`/`setState()`, so `onMutate`/
// `onError` still exercise genuine store mutations.
mock.module('../../browser/stores/runtime-compaction-store', () => ({
  useRuntimeCompactionStore: Object.assign(
    (selector: (s: ReturnType<typeof realCompactionStore.getState>) => unknown) =>
      selector(realCompactionStore.getState()),
    {
      getState: realCompactionStore.getState,
      setState: realCompactionStore.setState,
    },
  ),
}));

// The session-log action route of the active runtime: null = an older box (the default here).
let actionImpl: (method: string, path: string, body?: unknown) => Promise<Response> = async () => Response.json({ ok: true }, { status: 202 });
const realRuntimeActions = await import('../../core/session/runtime-actions');
mock.module('../../core/session/runtime-actions', () => ({
  ...realRuntimeActions,
  activeRuntimeAction: (method: string, path: string, body?: unknown) => actionImpl(method, path, body),
}));

const { useSummarizeRuntimeSession, useForkSession } = await import('./sessions');

beforeEach(() => {
  fakeQueryClient = makeFakeQueryClient();
  clientImpl = {};
  actionImpl = async () => Response.json({ ok: true }, { status: 202 });
});

describe('useSummarizeRuntimeSession: the compact action route', () => {
  test('posts the compact route of the session: no model, no history read, no compatibility call', async () => {
    const calls: unknown[] = [];
    actionImpl = async (method, path, body) => (calls.push([method, path, body]), Response.json({ ok: true }, { status: 202 }));
    clientImpl = { session: new Proxy({}, { get: () => { throw new Error('the compatibility client must not be used'); } }) };
    const { mutationFn } = useSummarizeRuntimeSession() as unknown as {
      mutationFn: (args: { sessionId: string }) => Promise<string>;
    };
    expect(await mutationFn({ sessionId: 'ses_1' })).toBe('ses_1');
    expect(calls).toEqual([['POST', '/kortix/runtime/sessions/ses_1/compact', undefined]]);
  });

  test('a refused compaction throws the runtime message', async () => {
    actionImpl = async () => Response.json({ error: 'the runtime cannot compact' }, { status: 501 });
    const { mutationFn } = useSummarizeRuntimeSession() as unknown as {
      mutationFn: (args: { sessionId: string }) => Promise<string>;
    };
    await expect(mutationFn({ sessionId: 'ses_1' })).rejects.toThrow('the runtime cannot compact');
  });
});

// ============================================================================
// useSummarizeRuntimeSession — the compaction store around the send.
// ============================================================================

describe('useSummarizeRuntimeSession — the compaction store', () => {
  test('onMutate/onError toggle the compaction store around the send', () => {
    clientImpl = { session: { messages: async () => ({ data: [] }) } };
    const hook = useSummarizeRuntimeSession() as unknown as {
      onMutate: (args: { sessionId: string }) => void;
      onError: (err: unknown, args: { sessionId: string }) => void;
    };
    // The store holds the ms epoch this tab issued `/compact`, not a boolean:
    // `projectCompacting` bounds the stamp, so a lost `session.compacted`
    // frame can no longer pin the composer for the lifetime of the tab.
    const before = Date.now();
    hook.onMutate({ sessionId: 'ses_compact' });
    const stamp = realCompactionStore.getState().compactingBySession.ses_compact;
    expect(stamp).toBeNumber();
    expect(stamp).toBeGreaterThanOrEqual(before);
    hook.onError(new Error('boom'), { sessionId: 'ses_compact' });
    expect(realCompactionStore.getState().compactingBySession.ses_compact).toBeUndefined();
  });
});

// ============================================================================
// useInitSession — /init command error duck-typing + refetch-on-success.
// ============================================================================

// ============================================================================
// useForkSession — the runtime's own fork (`POST /session/{id}/fork`).
// ============================================================================

describe('useForkSession', () => {
  test('a successful fork refreshes persistent project inventories', async () => {
    const forked: Session = {
      id: 'ses_fork', slug: 'fork', projectID: 'project', directory: '/workspace',
      title: 'Fork', version: '1', time: { created: 1, updated: 1 },
    };
    useForkSession();
    if (!mutationSuccess) throw new Error('Missing mutation onSuccess');
    await mutationSuccess(forked);
    const call = fakeQueryClient.refetchCalls[0];
    if (!call?.predicate) throw new Error('Missing inventory refetch predicate');
    expect(call.predicate({ queryKey: [...qk.project.sessions('p')] })).toBe(true);
    expect(call.predicate({ queryKey: ['runtime', 'sessions'] })).toBe(false);
  });

  test('forks the conversation and returns the forked session', async () => {
    const forked = { id: 'ses_fork', title: 'Old (fork #1)', time: { updated: 5 } };
    let forkArgs: unknown;
    clientImpl = {
      session: {
        fork: async (args: unknown) => {
          forkArgs = args;
          return { data: forked };
        },
      },
    };
    const { mutationFn } = useForkSession() as unknown as {
      mutationFn: (args: { sessionId: string; messageID?: string }) => Promise<typeof forked>;
    };
    const result = await mutationFn({ sessionId: 'ses_1' });
    expect(result).toEqual(forked);
    expect(forkArgs).toEqual({ sessionID: 'ses_1' });
  });

  test('passes the fork-at message through', async () => {
    let forkArgs: unknown;
    clientImpl = {
      session: {
        fork: async (args: unknown) => {
          forkArgs = args;
          return { data: { id: 'ses_fork', time: { updated: 5 } } };
        },
      },
    };
    const { mutationFn } = useForkSession() as unknown as {
      mutationFn: (args: { sessionId: string; messageID?: string }) => Promise<unknown>;
    };
    await mutationFn({ sessionId: 'ses_1', messageID: 'msg_9' });
    expect(forkArgs).toEqual({ sessionID: 'ses_1', messageID: 'msg_9' });
  });

  test('propagates a runtime error', async () => {
    clientImpl = {
      session: { fork: async () => ({ error: { name: 'NotFoundError', data: { message: 'no such session' } } }) },
    };
    const { mutationFn } = useForkSession() as unknown as {
      mutationFn: (args: { sessionId: string }) => Promise<unknown>;
    };
    await expect(mutationFn({ sessionId: 'ses_1' })).rejects.toThrow('no such session');
  });

  test('onSuccess inserts the fork into the sessions cache and caches it by id', () => {
    const forked = { id: 'ses_fork', title: 'Old (fork #1)', time: { updated: 5 } };
    // The `./keys` module is globally mocked by sibling test files (providers,
    // vcs), so the real factories are not importable in a full-suite run. Read
    // the writes back by shape instead: the hook makes exactly two writes, the
    // sessions LIST (an array) and the fork cached under its own id.
    const writes: Array<{ value: unknown }> = [];
    const original = fakeQueryClient.setQueryData;
    fakeQueryClient.setQueryData = (key: readonly unknown[], updater: unknown) => {
      const value = original(key, updater);
      writes.push({ value });
      return value;
    };
    const { onSuccess } = useForkSession() as unknown as {
      onSuccess: (session: typeof forked) => void;
    };
    onSuccess(forked as never);
    fakeQueryClient.setQueryData = original;
    expect(writes).toHaveLength(2);
    const lists = writes.map((w) => w.value).filter((v): v is Array<{ id: string }> => Array.isArray(v));
    expect(lists).toHaveLength(1);
    expect(lists[0]!.map((s) => s.id)).toEqual(['ses_fork']);
    expect(writes.map((w) => w.value)).toContainEqual(forked);
  });
});
