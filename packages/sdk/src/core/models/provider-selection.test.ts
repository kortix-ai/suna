import { describe, expect, test } from 'bun:test';

import type { ProviderAuthRequirement } from '@kortix/llm-catalog/lite';
import {
  connectedGatewayProviderIdsFromSecretNames,
  mergeProjectSecretConnectedProviders,
  normalizeProviderList,
  type ProviderListResponse,
} from './provider-selection';

describe('normalizeProviderList', () => {
  // The module's single normalization gate: EVERY return path assigns `all`
  // and `connected` as literal arrays. Downstream code reads them directly —
  // this invariant is what makes a second Array.isArray guard downstream dead.
  test('every shape in, arrays out', () => {
    const shapes: unknown[] = [
      { all: [{ id: 'a', models: {} }], connected: ['a'] },
      { all: [], connected: [] },
      { all: undefined, connected: undefined, providers: [{ id: 'legacy', models: {} }] },
      { all: undefined, connected: undefined, providers: 'not-an-array' },
      { all: undefined, connected: undefined },
      {},
    ];
    for (const shape of shapes) {
      const normalized = normalizeProviderList(shape as ProviderListResponse);
      expect(Array.isArray(normalized.all)).toBe(true);
      expect(Array.isArray(normalized.connected)).toBe(true);
    }
  });

  test('the legacy `.providers` shape is lifted, its ids connected', () => {
    const normalized = normalizeProviderList({
      providers: [{ id: 'legacy', models: {} }],
    } as unknown as ProviderListResponse);
    expect(normalized.all).toEqual([{ id: 'legacy', models: {} }]);
    expect(normalized.connected).toEqual(['legacy']);
  });

  test('the modern shape passes through with its arrays kept', () => {
    const modern = { all: [{ id: 'a', models: {} }], connected: ['a'], default: { a: 'm' } };
    expect(normalizeProviderList(modern as ProviderListResponse)).toEqual(modern);
  });
});

const creds: Array<{ id: string; authRequirement: ProviderAuthRequirement }> = [
  { id: 'acme', authRequirement: { methods: [{ envVars: ['ACME_API_KEY'] }] } },
  { id: 'beta', authRequirement: { methods: [{ envVars: ['BETA_API_KEY'] }] } },
];

function list(allIds: string[], connected: string[]): ProviderListResponse {
  return {
    all: allIds.map((id) => ({ id, models: {} })),
    connected,
    default: {},
  } as ProviderListResponse;
}

describe('mergeProjectSecretConnectedProviders', () => {
  test('a provider whose auth the secret NAMES satisfy flips to connected', () => {
    const merged = mergeProjectSecretConnectedProviders(list(['acme', 'beta'], []), new Set(['ACME_API_KEY']), creds);
    expect(merged.connected).toEqual(['acme']);
  });

  test('an already-connected provider stays; an unsatisfied one does not flip', () => {
    const merged = mergeProjectSecretConnectedProviders(
      list(['acme', 'beta'], ['beta']),
      new Set(['ACME_API_KEY']),
      creds,
    );
    expect(merged.connected).toEqual(['beta', 'acme']);
  });

  test('a provider the list does not carry is never added by its secret', () => {
    const merged = mergeProjectSecretConnectedProviders(list(['acme'], []), new Set(['BETA_API_KEY', 'ACME_API_KEY']), creds);
    expect(merged.connected).toEqual(['acme']);
  });

  test('the parameterized credential list decides — not the module catalog', () => {
    const other: Array<{ id: string; authRequirement: ProviderAuthRequirement }> = [
      { id: 'gamma', authRequirement: { methods: [{ envVars: ['GAMMA_KEY'] }] } },
    ];
    const merged = mergeProjectSecretConnectedProviders(list(['acme', 'gamma'], []), new Set(['GAMMA_KEY']), other);
    expect(merged.connected).toEqual(['gamma']);
  });

  test('the codex auth-json exception connects codex from either file name', () => {
    for (const secret of ['CODEX_AUTH_JSON', 'OPENCODE_AUTH_JSON']) {
      const merged = mergeProjectSecretConnectedProviders(list(['codex'], []), new Set([secret]), []);
      expect(merged.connected).toEqual(['codex']);
    }
  });

  test('the codex exception does not add codex when the list does not carry it', () => {
    const merged = mergeProjectSecretConnectedProviders(list(['acme'], []), new Set(['CODEX_AUTH_JSON']), []);
    expect(merged.connected).toEqual([]);
  });
});

describe('connectedGatewayProviderIdsFromSecretNames', () => {
  test('satisfied credentials and the codex exception, independent of any provider list', () => {
    const ids = connectedGatewayProviderIdsFromSecretNames(new Set(['CODEX_AUTH_JSON']));
    expect(ids.has('codex')).toBe(true);
    expect(connectedGatewayProviderIdsFromSecretNames(new Set()).size).toBe(0);
  });

  test('a one-argument call uses the shared LLM provider credentials', () => {
    // The real catalog names anthropic's env var; a secret by that name connects it.
    const ids = connectedGatewayProviderIdsFromSecretNames(new Set(['ANTHROPIC_API_KEY']));
    expect(ids.has('anthropic')).toBe(true);
  });
});
