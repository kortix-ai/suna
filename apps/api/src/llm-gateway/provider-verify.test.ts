// verifyProviderConnection classifies one cheap live completion into the
// verdict the provider UI renders. Resolution is injected; the completion
// runs through the real `callUpstream` with `globalThis.fetch` stubbed, so
// each row exercises the same transport a real turn uses.
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
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
let fetchCalls: Array<{ url: string; body: Record<string, unknown>; signal: AbortSignal | null | undefined }> = [];

function stubFetch(answer: (init?: RequestInit) => Response | Promise<Response>): void {
  fetchCalls = [];
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')), signal: init?.signal });
    return answer(init);
  }) as unknown as typeof fetch;
}

const ANTHROPIC_DEPS = deps({
  pickVerificationModel: () => 'anthropic/claude-haiku-4-5',
  resolveCandidates: async () => [ANTHROPIC],
});

function anthropicError(status: number, type: string, message: string): Response {
  return new Response(JSON.stringify({ type: 'error', error: { type, message } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
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
  mock.restore();
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
    // The ping carries the verification timeout, so a hung provider cannot
    // leave "Verifying…" spinning.
    expect(fetchCalls[0]?.signal).toBeInstanceOf(AbortSignal);
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

  // The AI SDK transport THROWS an UpstreamHttpError for a non-2xx answer, so
  // these rows reach the thrown-error verdicts, not the `!response.ok` ones.
  test.each([
    ['a 401 is invalid', 401, 'authentication_error', 'invalid x-api-key', 'invalid', 'invalid x-api-key'],
    ['a 403 is invalid', 403, 'permission_error', 'key lacks model access', 'invalid', 'key lacks model access'],
    ['a 429 is unknown', 429, 'rate_limit_error', 'slow down', 'unknown', "Rate limited while verifying — couldn't confirm the key."],
    ['a 400 is unknown', 400, 'invalid_request_error', 'max_tokens too small', 'unknown', 'max_tokens too small'],
    ['a 500 is unknown', 500, 'api_error', 'internal failure', 'unknown', 'internal failure'],
  ] as const)('an AI SDK upstream answering %s', async (_name, status, type, upstreamMessage, verdict, message) => {
    stubFetch(() => anthropicError(status, type, upstreamMessage));

    expect(await verifyProviderConnection(PRINCIPAL, 'anthropic', ANTHROPIC_DEPS)).toEqual({ status: verdict, message });
    expect(fetchCalls).toHaveLength(1);
  });

  // The verification timeout fires while the fetch is in flight. The direct
  // transport rejects with the signal's TimeoutError; the AI SDK transport
  // rethrows a ClientAbortError. Both are the same verdict.
  test.each([
    ['an openai-compatible', 'openai', deps()],
    ['an AI SDK', 'anthropic', ANTHROPIC_DEPS],
  ] as const)('%s upstream that outlives the verification timeout is unknown', async (_name, providerId, overrides) => {
    const verificationTimeout = new AbortController();
    spyOn(AbortSignal, 'timeout').mockImplementationOnce(() => verificationTimeout.signal);
    stubFetch(
      (init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) return reject(new Error('the ping carried no abort signal'));
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          verificationTimeout.abort(new DOMException('The operation timed out.', 'TimeoutError'));
        }),
    );

    expect(await verifyProviderConnection(PRINCIPAL, providerId, overrides)).toEqual({
      status: 'unknown',
      message: "Verification timed out — couldn't confirm the key.",
    });
  });

  test('a network failure is unknown with its message', async () => {
    stubFetch(() => {
      throw new TypeError('fetch failed: connection refused');
    });

    expect(await verifyProviderConnection(PRINCIPAL, 'openai', deps())).toEqual({
      status: 'unknown',
      message: 'fetch failed: connection refused',
    });
  });
});
