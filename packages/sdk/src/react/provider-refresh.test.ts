import { describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';

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
