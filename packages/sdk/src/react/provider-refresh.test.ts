import { describe, expect, test } from 'bun:test';
import type { QueryClient } from '@tanstack/react-query';

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
