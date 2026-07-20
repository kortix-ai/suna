import { describe, expect, test } from 'bun:test';

import {
  LLM_PROVIDER_CREDENTIALS,
  type ProviderListResponse,
  connectedGatewayProviderIdsFromSecretNames,
  mergeProjectSecretConnectedProviders,
} from './provider-selection';

describe('LLM_PROVIDER_CREDENTIALS — Kortix auth requirements, not raw catalog env', () => {
  test('amazon-bedrock requires only the bearer token + region', () => {
    const bedrock = LLM_PROVIDER_CREDENTIALS.find((p) => p.id === 'amazon-bedrock');
    expect(bedrock?.authRequirement.methods).toEqual([
      { envVars: ['AWS_BEARER_TOKEN_BEDROCK', 'AWS_REGION'], label: 'Bearer token' },
    ]);
  });
});

describe('connectedGatewayProviderIdsFromSecretNames (SDK native-mode path)', () => {
  test('amazon-bedrock connects via bearer token + region alone — the essentia case', () => {
    const ids = connectedGatewayProviderIdsFromSecretNames(
      new Set(['AWS_BEARER_TOKEN_BEDROCK', 'AWS_REGION']),
    );
    expect(ids.has('amazon-bedrock')).toBe(true);
  });

  test('a bearer token with no region does not connect', () => {
    const ids = connectedGatewayProviderIdsFromSecretNames(new Set(['AWS_BEARER_TOKEN_BEDROCK']));
    expect(ids.has('amazon-bedrock')).toBe(false);
  });

  test('the unimplemented SigV4 pair never satisfies Bedrock, even with a region set', () => {
    const ids = connectedGatewayProviderIdsFromSecretNames(
      new Set(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION']),
    );
    expect(ids.has('amazon-bedrock')).toBe(false);
  });

  test('a single-secret provider (anthropic) still connects the old way', () => {
    const ids = connectedGatewayProviderIdsFromSecretNames(new Set(['ANTHROPIC_API_KEY']));
    expect(ids.has('anthropic')).toBe(true);
  });

  // Pinned from apps/web/src/hooks/runtime/provider-selection.test.ts before
  // that web-side copy is retired in favor of this SDK helper.
  test('maps ChatGPT subscription secrets to the codex gateway provider', () => {
    expect([...connectedGatewayProviderIdsFromSecretNames(new Set(['CODEX_AUTH_JSON']))]).toEqual([
      'codex',
    ]);
    expect([
      ...connectedGatewayProviderIdsFromSecretNames(new Set(['OPENCODE_AUTH_JSON'])),
    ]).toEqual(['codex']);
  });
});

describe('mergeProjectSecretConnectedProviders (SDK native-mode provider merge)', () => {
  function bareProviders(ids: string[]): ProviderListResponse {
    return {
      default: {},
      connected: [],
      all: ids.map((id) => ({
        id,
        name: id,
        models: { [`${id}-model`]: { name: `${id} model` } },
      })),
    } as unknown as ProviderListResponse;
  }

  test('marks Bedrock connected from project secrets alone (bearer + region)', () => {
    const merged = mergeProjectSecretConnectedProviders(
      bareProviders(['amazon-bedrock']),
      new Set(['AWS_BEARER_TOKEN_BEDROCK', 'AWS_REGION']),
      LLM_PROVIDER_CREDENTIALS,
    );
    expect(merged.connected).toContain('amazon-bedrock');
  });

  test('does not mark Bedrock connected from a partial secret set', () => {
    const merged = mergeProjectSecretConnectedProviders(
      bareProviders(['amazon-bedrock']),
      new Set(['AWS_REGION']),
      LLM_PROVIDER_CREDENTIALS,
    );
    expect(merged.connected).not.toContain('amazon-bedrock');
  });
});
