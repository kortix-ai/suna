import { describe, expect, test, beforeEach, mock } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2/client';
// Imported BEFORE `mock.module` below runs, so this binds to the REAL store
// (module resolution for a static import happens before the rest of this
// file's top-level code executes) — used as the mock's backing state so
// `onMutate`/`onError` assertions see genuine store mutations.
import { useOpenCodeCompactionStore as realCompactionStore } from '../../browser/stores/opencode-compaction-store';

// react-query's `useQuery`/`useMutation` are mocked down to identity functions
// (return the config object passed in) so the hooks under test can be called
// as plain functions — same harness as `./messages.test.ts` /
// `../use-kortix-master.test.ts`. `useQueryClient` returns a minimal
// hand-rolled cache (not a real `QueryClient`) with just the methods these
// three hooks actually call.
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
// what `client.global.config.get()` / `client.session.messages()` /
// `client.provider.list()` / `client.session.summarize()` /
// `client.session.fork()` / `client.session.command()` resolve to.
let clientImpl: Record<string, unknown> = {};
mock.module('../../core/runtime/client', () => ({
  getClient: () => clientImpl,
}));

// `useOpenCodeCompactionStore` is a real zustand hook — calling it outside a
// React render (as this file does, invoking hooks as plain functions) throws
// "Invalid hook call". Replace the reactive wrapper with a plain selector
// call against the REAL store's `getState()`/`setState()`, so `onMutate`/
// `onError` still exercise genuine store mutations.
mock.module('../../browser/stores/opencode-compaction-store', () => ({
  useOpenCodeCompactionStore: Object.assign(
    (selector: (s: ReturnType<typeof realCompactionStore.getState>) => unknown) =>
      selector(realCompactionStore.getState()),
    { getState: realCompactionStore.getState, setState: realCompactionStore.setState },
  ),
}));

const { useSummarizeOpenCodeSession, useForkSession, useInitSession } = await import('./sessions');
const { opencodeKeys } = await import('./keys');

beforeEach(() => {
  fakeQueryClient = makeFakeQueryClient();
  clientImpl = {};
});

// ============================================================================
// useSummarizeOpenCodeSession — the 3-tier model-resolution fallback chain
// (config default → last assistant message → first connected provider/model)
// ============================================================================

describe('useSummarizeOpenCodeSession — model resolution fallback chain', () => {
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
    const { mutationFn } = useSummarizeOpenCodeSession() as unknown as {
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
    const { mutationFn } = useSummarizeOpenCodeSession() as unknown as {
      mutationFn: (args: { sessionId: string }) => Promise<string>;
    };
    await mutationFn({ sessionId: 'ses_1' });
    expect(summarizeArgs).toEqual({ sessionID: 'ses_1', providerID: 'openrouter', modelID: 'z-ai/glm-5.2' });
  });

  test('tier 2: falls back to the session\'s last assistant message model when config has none', async () => {
    let summarizeArgs: unknown;
    clientImpl = {
      global: { config: { get: async () => ({ data: {} }) } },
      session: {
        messages: async () => ({
          data: [
            { info: { role: 'user' } },
            { info: { role: 'assistant', providerID: 'anthropic', modelID: 'claude-sonnet' } },
          ],
        }),
        summarize: async (args: unknown) => {
          summarizeArgs = args;
          return { data: {} };
        },
      },
    };
    const { mutationFn } = useSummarizeOpenCodeSession() as unknown as {
      mutationFn: (args: { sessionId: string }) => Promise<string>;
    };
    await mutationFn({ sessionId: 'ses_1' });
    expect(summarizeArgs).toEqual({ sessionID: 'ses_1', providerID: 'anthropic', modelID: 'claude-sonnet' });
  });

  test('tier 3: falls back to the first connected provider/model when config and history have none', async () => {
    let summarizeArgs: unknown;
    clientImpl = {
      global: { config: { get: async () => ({ data: {} }) } },
      session: {
        messages: async () => ({ data: [] }),
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
    const { mutationFn } = useSummarizeOpenCodeSession() as unknown as {
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
    const { mutationFn } = useSummarizeOpenCodeSession() as unknown as {
      mutationFn: (args: { sessionId: string; providerID?: string; modelID?: string }) => Promise<string>;
    };
    await mutationFn({ sessionId: 'ses_1', providerID: 'anthropic', modelID: 'claude-haiku' });

    expect(configFetched).toBe(false);
    expect(summarizeArgs).toEqual({ sessionID: 'ses_1', providerID: 'anthropic', modelID: 'claude-haiku' });
  });

  test('throws when every tier fails to resolve a model', async () => {
    clientImpl = {
      global: { config: { get: async () => ({ data: {} }) } },
      session: { messages: async () => ({ data: [] }) },
      provider: { list: async () => ({ data: {} }) },
    };
    const { mutationFn } = useSummarizeOpenCodeSession() as unknown as {
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
        messages: async () => ({ data: [{ info: { role: 'assistant', providerID: 'anthropic', modelID: 'x' } }] }),
        summarize: async (args: unknown) => { summarizeArgs = args; return { data: {} }; },
      },
    };
    const { mutationFn } = useSummarizeOpenCodeSession() as unknown as {
      mutationFn: (args: { sessionId: string }) => Promise<string>;
    };
    await mutationFn({ sessionId: 'ses_1' });
    expect(summarizeArgs).toEqual({ sessionID: 'ses_1', providerID: 'anthropic', modelID: 'x' });
  });

  test('onMutate/onError toggle the compaction store around the send', () => {
    clientImpl = {
      global: { config: { get: async () => ({ data: {} }) } },
      session: { messages: async () => ({ data: [] }) },
      provider: { list: async () => ({ data: {} }) },
    };
    const hook = useSummarizeOpenCodeSession() as unknown as {
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
// useForkSession — onSuccess dedups the forked session into the cached list.
// ============================================================================

describe('useForkSession', () => {
  function forkedSession(id: string, updated: number): Session {
    return {
      id,
      slug: id,
      projectID: 'proj_1',
      directory: '/workspace',
      title: 'Forked',
      version: '1.0.0',
      time: { created: updated, updated },
    };
  }

  test('mutationFn sends only the provided optional fields and unwraps the result', async () => {
    let forkArgs: unknown;
    clientImpl = {
      session: {
        fork: async (args: unknown) => {
          forkArgs = args;
          return { data: forkedSession('ses_fork', 5) };
        },
      },
    };
    const { mutationFn } = useForkSession() as unknown as {
      mutationFn: (args: { sessionId: string; messageId?: string }) => Promise<Session>;
    };
    const result = await mutationFn({ sessionId: 'ses_1', messageId: 'msg_5' });

    expect(forkArgs).toEqual({ sessionID: 'ses_1', messageID: 'msg_5' });
    expect(result.id).toBe('ses_fork');
  });

  test('onSuccess inserts a brand-new forked session at the front, newest first', () => {
    const { onSuccess } = useForkSession() as unknown as { onSuccess: (s: Session) => void };
    fakeQueryClient.setQueryData(opencodeKeys.sessions(), [forkedSession('ses_old', 1)]);

    onSuccess(forkedSession('ses_new', 10));

    const list = fakeQueryClient.getQueryData(opencodeKeys.sessions()) as Session[];
    expect(list.map((s) => s.id)).toEqual(['ses_new', 'ses_old']);
    expect(fakeQueryClient.getQueryData(opencodeKeys.session('ses_new'))).toMatchObject({ id: 'ses_new' });
  });

  test('onSuccess replaces (dedups) an existing entry instead of duplicating it', () => {
    const { onSuccess } = useForkSession() as unknown as { onSuccess: (s: Session) => void };
    fakeQueryClient.setQueryData(opencodeKeys.sessions(), [
      forkedSession('ses_a', 1),
      forkedSession('ses_fork', 2),
    ]);

    onSuccess(forkedSession('ses_fork', 20));

    const list = fakeQueryClient.getQueryData(opencodeKeys.sessions()) as Session[];
    expect(list).toHaveLength(2);
    expect(list.find((s) => s.id === 'ses_fork')?.time.updated).toBe(20);
  });
});

// ============================================================================
// useInitSession — /init command error duck-typing + refetch-on-success.
// ============================================================================

describe('useInitSession', () => {
  test('resolves with the sessionId on success and refetches its messages', async () => {
    clientImpl = { session: { command: async () => ({}) } };
    const hook = useInitSession() as unknown as {
      mutationFn: (args: { sessionId: string }) => Promise<string>;
      onSuccess: (sessionId: string) => void;
    };
    const result = await hook.mutationFn({ sessionId: 'ses_1' });
    expect(result).toBe('ses_1');

    hook.onSuccess('ses_1');
    expect(fakeQueryClient.refetchCalls).toEqual([{ queryKey: opencodeKeys.messages('ses_1') }]);
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
