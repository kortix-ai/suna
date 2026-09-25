// verifyProviderConnection classifies one cheap live completion into the
// verdict the provider UI renders. Resolution is injected; the completion
// runs through the real `callUpstream` with `globalThis.fetch` stubbed, so
// each row exercises the same transport a real turn uses.
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { GatewayResolutionError } from '@kortix/llm-gateway';
import type { AuthedPrincipal, UpstreamDescriptor } from '@kortix/llm-gateway';
import { verifyProviderConnection, type ProviderVerifyDeps } from './provider-verify';

const PRINCIPAL: AuthedPrincipal = { userId: 'user-1', accountId: 'acct-1', projectId: 'project-1' };

const OPENAI_COMPAT: UpstreamDescriptor = {
  provider: 'openai',
  kind: 'openai-compat',
  baseUrl: 'https://upstream.example.test/v1',
  apiKey: 'sk-test',
  billingMode: 'none',
  markup: 0,
  resolvedModel: 'gpt-4o-mini',
};

const ANTHROPIC: UpstreamDescriptor = {
  provider: 'anthropic',
  kind: 'anthropic',
  baseUrl: 'https://upstream.example.test/v1',
  apiKey: 'sk-ant-test',
  billingMode: 'none',
  markup: 0,
  resolvedModel: 'claude-haiku-4-5',
  npm: '@ai-sdk/anthropic',
};

const realFetch = globalThis.fetch;
let fetchCalls: Array<{ url: string; body: Record<string, unknown> }> = [];

function stubFetch(answer: () => Response | Promise<Response>): void {
  fetchCalls = [];
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) });
    return answer();
  }) as unknown as typeof fetch;
}

function deps(overrides: Partial<ProviderVerifyDeps> = {}): Partial<ProviderVerifyDeps> {
  return {
    pickVerificationModel: () => 'openai/gpt-4o-mini',
    resolveCandidates: async () => [OPENAI_COMPAT],
    ...overrides,
  };
}

const errorBody = (message: string) => JSON.stringify({ error: { message } });

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('verifyProviderConnection before the upstream call', () => {
  test('no catalog model to verify against is unknown and resolves nothing', async () => {
    const resolveCandidates = mock(async () => [OPENAI_COMPAT]);

    const result = await verifyProviderConnection(
      PRINCIPAL,
      'made-up-provider',
      deps({ pickVerificationModel: () => null, resolveCandidates }),
    );

    expect(result).toEqual({
      status: 'unknown',
      message: 'No catalog model is known for "made-up-provider" to verify against.',
    });
    expect(resolveCandidates).not.toHaveBeenCalled();
  });

  test.each([
    ['provider_not_connected', 'not_connected'],
    ['provider_reauth_required', 'invalid'],
    ['model_not_found', 'unknown'],
  ] as const)('a %s resolution error is %s and calls no upstream', async (code, status) => {
    stubFetch(() => new Response('{}'));

    const result = await verifyProviderConnection(
      PRINCIPAL,
      'openai',
      deps({
        resolveCandidates: async () => {
          throw new GatewayResolutionError(code, `resolution failed: ${code}`, 'hint');
        },
      }),
    );

    expect(result).toEqual({ status, message: `resolution failed: ${code}` });
    expect(fetchCalls).toEqual([]);
  });

  test('no resolved candidate is unknown', async () => {
    const result = await verifyProviderConnection(PRINCIPAL, 'openai', deps({ resolveCandidates: async () => [] }));

    expect(result).toEqual({ status: 'unknown', message: 'No upstream candidate was resolved for this provider.' });
  });
});

describe('verifyProviderConnection upstream verdicts', () => {
  test('an accepted key is verified after one bounded, non-streaming ping', async () => {
    stubFetch(() => Response.json({ choices: [] }));

    const result = await verifyProviderConnection(PRINCIPAL, 'openai', deps());

    expect(result).toEqual({ status: 'verified', message: 'The provider accepted the key.' });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe('https://upstream.example.test/v1/chat/completions');
    expect(fetchCalls[0]?.body).toMatchObject({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'ping' }],
      stream: false,
      max_tokens: 16,
    });
  });

  test.each([
    ['a 401 with a provider message is invalid', 401, errorBody('Incorrect API key provided'), 'invalid', 'Incorrect API key provided'],
    ['a 403 without a body is invalid', 403, '', 'invalid', 'The provider rejected the key (HTTP 403).'],
    ['a 429 is unknown', 429, errorBody('slow down'), 'unknown', "Rate limited while verifying — couldn't confirm the key."],
    ['a 400 with a provider message is unknown', 400, errorBody('model requires more tokens'), 'unknown', 'model requires more tokens'],
    ['a 500 without a body is unknown', 500, '', 'unknown', "The provider returned HTTP 500 — couldn't confirm."],
  ] as const)('an openai-compatible upstream answering %s', async (_name, status, body, verdict, message) => {
    stubFetch(() => new Response(body, { status }));

    expect(await verifyProviderConnection(PRINCIPAL, 'openai', deps())).toEqual({ status: verdict, message });
  });

  test('an AI SDK upstream rejecting the key throws, and the verdict is invalid with its message', async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
    );

    const result = await verifyProviderConnection(
      PRINCIPAL,
      'anthropic',
      deps({ pickVerificationModel: () => 'anthropic/claude-haiku-4-5', resolveCandidates: async () => [ANTHROPIC] }),
    );

    expect(result).toEqual({ status: 'invalid', message: 'invalid x-api-key' });
    expect(fetchCalls).toHaveLength(1);
  });

  test.each([
    [
      'a timed-out fetch',
      () => new DOMException('The operation timed out.', 'TimeoutError'),
      "Verification timed out — couldn't confirm the key.",
    ],
    ['a network failure', () => new TypeError('fetch failed: connection refused'), 'fetch failed: connection refused'],
  ] as const)('%s is unknown', async (_name, failure, message) => {
    stubFetch(() => {
      throw failure();
    });

    expect(await verifyProviderConnection(PRINCIPAL, 'openai', deps())).toEqual({ status: 'unknown', message });
  });
});
