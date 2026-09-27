import { afterEach, describe, expect, test } from 'bun:test';
import { QueryClient, QueryObserver } from '@tanstack/react-query';

import { providerConnectedInSecrets, refreshProjectProviderState } from './provider-refresh';
import { qk } from './query-keys';

describe('providerConnectedInSecrets', () => {
  test('false for empty, null, or malformed responses', () => {
    expect(providerConnectedInSecrets(undefined, 'anthropic')).toBe(false);
    expect(providerConnectedInSecrets(null, 'anthropic')).toBe(false);
    expect(providerConnectedInSecrets([], 'anthropic')).toBe(false);
    expect(providerConnectedInSecrets({ items: [] }, 'anthropic')).toBe(false);
    expect(providerConnectedInSecrets({ items: [{ notName: 1 }] }, 'anthropic')).toBe(false);
  });

  test('resolves a provider once its credential env var is present (array shape)', () => {
    expect(providerConnectedInSecrets([{ name: 'ANTHROPIC_API_KEY' }], 'anthropic')).toBe(true);
    expect(providerConnectedInSecrets([{ name: 'ANTHROPIC_API_KEY' }], 'openai')).toBe(false);
  });

  test('resolves a provider from the items envelope shape', () => {
    const secrets = { items: [{ name: 'OPENAI_API_KEY' }, { name: 'UNRELATED' }] };
    expect(providerConnectedInSecrets(secrets, 'openai')).toBe(true);
  });

  test('codex resolves from the subscription auth secret', () => {
    expect(providerConnectedInSecrets([{ name: 'CODEX_AUTH_JSON' }], 'codex')).toBe(true);
  });

  test('an unrelated secret never resolves a provider', () => {
    expect(providerConnectedInSecrets([{ name: 'STRIPE_API_KEY' }], 'anthropic')).toBe(false);
  });
});

// `refreshProjectProviderState` invalidates/refetches `qk.project.secrets(id)`
// synchronously before any `window`-gated poll. Pre-migration this was a
// standalone flat `project-secrets` array literal — the SAME literal
// `useProjectSecrets` and the Customize secrets view used to read, so the
// two happened to agree by accident of both being hand-typed the same way.
// Locking this to `qk.project.secrets` is what makes that agreement
// structural instead of coincidental.
describe('refreshProjectProviderState — key wiring', () => {
  test('invalidates and refetches the shared qk.project.secrets(id) entry', () => {
    const invalidated: unknown[] = [];
    const refetched: unknown[] = [];
    const queryClient = {
      invalidateQueries: (opts: unknown) => {
        invalidated.push(opts);
      },
      refetchQueries: (opts: unknown) => {
        refetched.push(opts);
        return Promise.resolve();
      },
      removeQueries: () => {},
    } as unknown as QueryClient;

    refreshProjectProviderState(queryClient, 'proj_1');

    const secretsKey = qk.project.secrets('proj_1');
    expect(invalidated).toContainEqual({ queryKey: secretsKey });
    expect(refetched).toContainEqual({ queryKey: secretsKey, type: 'all' });
  });
});

// THE DEFECT this covers: connecting a provider adds its models server-side,
// but the session model picker kept serving the pre-connect list until a HARD
// REFRESH.
//
// Why the existing invalidation missed it. Under the LLM gateway the picker's
// models do not come from `['project-providers', id, 'gateway']`'s own fetcher
// — that fetcher is a PROJECTION. The bytes come from `/model-picker`, cached
// one key away under `qk.project.modelPicker(id)` and read through
// `queryClient.fetchQuery` (see use-opencode-sessions/providers.ts, which
// routes through the shared entry so a session open makes ONE request instead
// of two). `fetchQuery` honours staleTime, and `modelPicker` is the `config`
// tier — 60s. So re-running the projection inside that window re-read the
// CACHED catalog and issued no request at all. Refetching a projection while
// its source stays fresh refreshes nothing.
//
// A hard refresh "fixed" it only because it dropped the in-memory cache.
describe('refreshProjectProviderState — the gateway catalog behind the picker', () => {
  const PROJECT_ID = 'proj_1';

  /**
   * The real shape from `use-opencode-sessions/providers.ts`: the gateway
   * provider entry is `staleTime: Infinity`, and its queryFn reads the catalog
   * through the SHARED `qk.project.modelPicker` entry at the `config` tier.
   */
  function gatewayPickerHarness() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const catalogKey = qk.project.modelPicker(PROJECT_ID);
    const providersKey = ['project-providers', PROJECT_ID, 'gateway'];
    let catalogFetches = 0;

    const readProviders = () =>
      queryClient.fetchQuery({
        queryKey: providersKey,
        queryFn: () =>
          queryClient.fetchQuery({
            queryKey: catalogKey,
            queryFn: async () => {
              catalogFetches += 1;
              return { models: {} };
            },
            staleTime: 60_000,
          }),
        staleTime: Infinity,
      });

    return { queryClient, catalogKey, providersKey, readProviders, count: () => catalogFetches };
  }

  test('marks the /model-picker catalog invalidated, not just the provider projection', () => {
    const { queryClient, catalogKey } = gatewayPickerHarness();
    queryClient.setQueryData(catalogKey, { models: {} });

    refreshProjectProviderState(queryClient, PROJECT_ID);

    // `fetchQuery` goes to the network only for a query that is stale OR
    // invalidated. Inside the 60s config window, invalidated is the only one
    // of the two a connect can cause.
    expect(queryClient.getQueryState(catalogKey)?.isInvalidated).toBe(true);
  });

  test('the next provider read goes back to the network inside the 60s config window', async () => {
    const harness = gatewayPickerHarness();

    await harness.readProviders();
    expect(harness.count()).toBe(1);

    // Re-reading with nothing invalidated is a cache hit — this is exactly the
    // state the picker was stuck in after a connect.
    await harness.queryClient.refetchQueries({ queryKey: harness.providersKey, type: 'all' });
    expect(harness.count()).toBe(1);

    refreshProjectProviderState(harness.queryClient, PROJECT_ID);
    await harness.queryClient.refetchQueries({ queryKey: harness.providersKey, type: 'all' });

    expect(harness.count()).toBe(2);
  });
});

// THE DEFECT this covers: after "Disconnect ChatGPT" the card kept its
// "connected" banner for seconds, or until the user gave up and reloaded.
//
// Every pass of this refresh invalidates and refetches the secrets entry, and
// TanStack's default for both is `cancelRefetch: true`: a running read is
// thrown away and a new one starts. The follow-up passes fire at
// 500/1500/3000/6000 ms. When `GET /secrets` takes longer than the gap to the
// next pass (it loads the project manifest from git on every call), each pass
// discards the read the previous pass started. The correct, post-write answer
// arrived and was dropped every time. Only the pass right after the write may
// supersede an in-flight read, because only that read can predate the write.
describe('refreshProjectProviderState — follow-up passes do not discard in-flight reads', () => {
  const PROJECT_ID = 'proj_1';
  const originalWindow = (globalThis as { window?: unknown }).window;

  function withFakeWindow() {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    (globalThis as { window?: unknown }).window = {
      setTimeout: (fn: () => void, ms: number) => {
        timers.push({ fn, ms });
        return timers.length;
      },
    };
    return timers;
  }

  afterEach(() => {
    (globalThis as { window?: unknown }).window = originalWindow;
  });

  test('a slow post-write read still lands after the 500 ms pass fires', async () => {
    const timers = withFakeWindow();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const key = qk.project.secrets(PROJECT_ID);
    const pending: Array<(value: { items: Array<{ name: string }> }) => void> = [];
    queryClient.setQueryData(key, { items: [{ name: 'CODEX_AUTH_JSON' }] });
    const observer = new QueryObserver(queryClient, {
      queryKey: key,
      queryFn: () => new Promise<{ items: Array<{ name: string }> }>((resolve) => pending.push(resolve)),
      staleTime: 60_000,
    });
    const unsubscribe = observer.subscribe(() => {});

    // The write just succeeded; the immediate pass starts a post-write read.
    refreshProjectProviderState(queryClient, PROJECT_ID);
    const postWriteRead = pending.length - 1;
    expect(postWriteRead).toBeGreaterThanOrEqual(0);

    // The read is slow. The 500 ms follow-up pass fires before it returns.
    timers.find((t) => t.ms === 500)!.fn();

    // The post-write read now returns the truth: the credential is gone.
    pending[postWriteRead]!({ items: [] });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(queryClient.getQueryData<unknown>(key)).toEqual({ items: [] });
    unsubscribe();
  });

  test('the pass right after the write still supersedes a read that predates it', async () => {
    withFakeWindow();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const key = qk.project.secrets(PROJECT_ID);
    const pending: Array<(value: { items: Array<{ name: string }> }) => void> = [];
    queryClient.setQueryData(key, { items: [{ name: 'CODEX_AUTH_JSON' }] });
    const observer = new QueryObserver(queryClient, {
      queryKey: key,
      queryFn: () => new Promise<{ items: Array<{ name: string }> }>((resolve) => pending.push(resolve)),
      staleTime: 60_000,
    });
    const unsubscribe = observer.subscribe(() => {});

    // A read started BEFORE the write (window focus, another surface).
    void queryClient.refetchQueries({ queryKey: key });
    const preWriteRead = pending.length - 1;

    refreshProjectProviderState(queryClient, PROJECT_ID);
    const postWriteRead = pending.length - 1;
    expect(postWriteRead).toBeGreaterThan(preWriteRead);

    // The stale pre-write answer arrives last-but-one; it must not win.
    pending[postWriteRead]!({ items: [] });
    pending[preWriteRead]!({ items: [{ name: 'CODEX_AUTH_JSON' }] });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(queryClient.getQueryData<unknown>(key)).toEqual({ items: [] });
    unsubscribe();
  });
});
