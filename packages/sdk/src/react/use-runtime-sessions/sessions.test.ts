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
  const refetchCalls: unknown[] = [];
  return {
    setQueryData: (k: readonly unknown[], updater: unknown) => {
      const existing = cache.get(cacheKey(k));
      const value = typeof updater === 'function' ? (updater as (old: unknown) => unknown)(existing) : updater;
      cache.set(cacheKey(k), value);
      return value;
    },
    getQueryData: (k: readonly unknown[]) => cache.get(cacheKey(k)),
    refetchQueries: (opts: unknown) => {
      refetchCalls.push(opts);
    },
    refetchCalls,
  };
}

let fakeQueryClient = makeFakeQueryClient();

mock.module('@tanstack/react-query', () => ({
  useQuery: (config: Record<string, unknown>) => config,
  useMutation: (config: Record<string, unknown>) => config,
  useQueryClient: () => fakeQueryClient,
}));

// `client` is swapped per-test via `clientImpl` so each test controls exactly
// what `client.global.config.get()` / `client.provider.list()` /
// `client.session.summarize()` / `client.session.command()` resolve to.
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
    { getState: realCompactionStore.getState, setState: realCompactionStore.setState },
  ),
}));

const { useSummarizeRuntimeSession, useInitSession } = await import('./sessions');
const { runtimeKeys } = await import('./keys');

beforeEach(() => {
  fakeQueryClient = makeFakeQueryClient();
  clientImpl = {};
});

// ============================================================================
// useSummarizeRuntimeSession — model-resolution fallback chain
// (config default → first connected provider/model)
// ============================================================================

describe('useSummarizeRuntimeSession — model resolution fallback chain', () => {
  test('tier 1: uses the config default model when neither providerID nor modelID is given', async () => {
    let summarizeArgs: unknown;
    clientImpl = {
      global: { config: { get: async () => ({ data: { model: 'anthropic/claude-opus' } }) } },
      session: {
        summarize: async (args: unknown) => {
          summarizeArgs = args;
          return { data: {} };
        },
      },
    };
    const { mutationFn } = useSummarizeRuntimeSession() as unknown as {
      mutationFn: (args: { sessionId: string }) => Promise<string>;
    };
    const result = await mutationFn({ sessionId: 'ses_1' });

    expect(result).toBe('ses_1');
    expect(summarizeArgs).toEqual({ sessionID: 'ses_1', providerID: 'anthropic', modelID: 'claude-opus' });
  });

  test('tier 1 splits a multi-segment model id: provider is the first segment, model is the rest', async () => {
    let summarizeArgs: unknown;
    clientImpl = {
      global: { config: { get: async () => ({ data: { model: 'openrouter/z-ai/glm-5.2' } }) } },
      session: { summarize: async (args: unknown) => { summarizeArgs = args; return { data: {} }; } },
    };
    const { mutationFn } = useSummarizeRuntimeSession() as unknown as {
      mutationFn: (args: { sessionId: string }) => Promise<string>;
    };
    await mutationFn({ sessionId: 'ses_1' });
    expect(summarizeArgs).toEqual({ sessionID: 'ses_1', providerID: 'openrouter', modelID: 'z-ai/glm-5.2' });
  });

  test('tier 2: falls back to the first connected provider/model when config has none', async () => {
    let summarizeArgs: unknown;
    clientImpl = {
      global: { config: { get: async () => ({ data: {} }) } },
      session: {
        summarize: async (args: unknown) => {
          summarizeArgs = args;
          return { data: {} };
        },
      },
      provider: {
        list: async () => ({
          data: { kortix: { models: { 'claude-opus-4.8': {} } } },
        }),
      },
    };
    const { mutationFn } = useSummarizeRuntimeSession() as unknown as {
      mutationFn: (args: { sessionId: string }) => Promise<string>;
    };
    await mutationFn({ sessionId: 'ses_1' });
    expect(summarizeArgs).toEqual({ sessionID: 'ses_1', providerID: 'kortix', modelID: 'claude-opus-4.8' });
  });

  test('an explicitly-passed providerID/modelID short-circuits every fallback tier', async () => {
    let summarizeArgs: unknown;
    let configFetched = false;
    clientImpl = {
      global: { config: { get: async () => { configFetched = true; return { data: {} }; } } },
      session: { summarize: async (args: unknown) => { summarizeArgs = args; return { data: {} }; } },
    };
    const { mutationFn } = useSummarizeRuntimeSession() as unknown as {
      mutationFn: (args: { sessionId: string; providerID?: string; modelID?: string }) => Promise<string>;
    };
    await mutationFn({ sessionId: 'ses_1', providerID: 'anthropic', modelID: 'claude-haiku' });

    expect(configFetched).toBe(false);
    expect(summarizeArgs).toEqual({ sessionID: 'ses_1', providerID: 'anthropic', modelID: 'claude-haiku' });
  });

  test('throws when every tier fails to resolve a model', async () => {
    clientImpl = {
      global: { config: { get: async () => ({ data: {} }) } },
      provider: { list: async () => ({ data: {} }) },
    };
    const { mutationFn } = useSummarizeRuntimeSession() as unknown as {
      mutationFn: (args: { sessionId: string }) => Promise<string>;
    };
    await expect(mutationFn({ sessionId: 'ses_1' })).rejects.toThrow(
      'No model available for compaction. Please configure a model in settings.',
    );
  });

  test('a thrown/rejected config.get() is swallowed — falls through to the next tier', async () => {
    let summarizeArgs: unknown;
    clientImpl = {
      global: { config: { get: async () => { throw new Error('network down'); } } },
      session: {
        summarize: async (args: unknown) => { summarizeArgs = args; return { data: {} }; },
      },
      provider: {
        list: async () => ({ data: { anthropic: { models: { x: {} } } } }),
      },
    };
    const { mutationFn } = useSummarizeRuntimeSession() as unknown as {
      mutationFn: (args: { sessionId: string }) => Promise<string>;
    };
    await mutationFn({ sessionId: 'ses_1' });
    expect(summarizeArgs).toEqual({ sessionID: 'ses_1', providerID: 'anthropic', modelID: 'x' });
  });

  test('onMutate/onError toggle the compaction store around the send', () => {
    clientImpl = {
      global: { config: { get: async () => ({ data: {} }) } },
      provider: { list: async () => ({ data: {} }) },
    };
    const hook = useSummarizeRuntimeSession() as unknown as {
      onMutate: (args: { sessionId: string }) => void;
      onError: (err: unknown, args: { sessionId: string }) => void;
    };
    hook.onMutate({ sessionId: 'ses_compact' });
    expect(realCompactionStore.getState().compactingBySession.ses_compact).toBe(true);
    hook.onError(new Error('boom'), { sessionId: 'ses_compact' });
    expect(realCompactionStore.getState().compactingBySession.ses_compact).toBeUndefined();
  });
});

// ============================================================================
// useInitSession — /init command error duck-typing.
// ============================================================================

describe('useInitSession', () => {
  test('resolves with the sessionId on success', async () => {
    clientImpl = { session: { command: async () => ({}) } };
    const hook = useInitSession() as unknown as {
      mutationFn: (args: { sessionId: string }) => Promise<string>;
      onSuccess: (sessionId: string) => void;
    };
    const result = await hook.mutationFn({ sessionId: 'ses_1' });
    expect(result).toBe('ses_1');

    hook.onSuccess('ses_1');
    expect(fakeQueryClient.refetchCalls).toEqual([]);
  });

  test('extracts a NotFoundError-shaped error message (`.data.message`)', async () => {
    clientImpl = {
      session: { command: async () => ({ error: { name: 'NotFoundError', data: { message: 'no such session' } } }) },
    };
    const { mutationFn } = useInitSession() as unknown as {
      mutationFn: (args: { sessionId: string }) => Promise<string>;
    };
    await expect(mutationFn({ sessionId: 'ses_1' })).rejects.toThrow('no such session');
  });

  test('falls back to a default message for a BadRequest-shaped error (no message field)', async () => {
    clientImpl = {
      session: { command: async () => ({ error: { _tag: 'BadRequest' } }) },
    };
    const { mutationFn } = useInitSession() as unknown as {
      mutationFn: (args: { sessionId: string }) => Promise<string>;
    };
    await expect(mutationFn({ sessionId: 'ses_1' })).rejects.toThrow('Failed to initialize project');
  });
});
