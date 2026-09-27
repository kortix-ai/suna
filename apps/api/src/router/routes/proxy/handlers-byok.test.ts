import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

let reserveCalls = 0;
let settleCalls = 0;
let refundCalls = 0;

mock.module('../../../config', () => ({
  config: { KORTIX_BILLING_INTERNAL_ENABLED: true, OPENROUTER_API_URL: 'https://openrouter.example' },
  KORTIX_MARKUP: 1.2,
}));

mock.module('../../services/llm-reservation', () => ({
  reserveEstimatedLlmCredits: async () => { reserveCalls += 1; return null; },
  settleLlmReservation: async () => { settleCalls += 1; },
  refundLlmReservation: async () => { refundCalls += 1; },
}));

mock.module('./helpers', () => ({
  tryAuthenticate: async () => ({ isKortixUser: true, isPassthrough: true, accountId: 'acct-synthetic' }),
  buildForwardHeaders: () => new Headers({ authorization: 'Bearer provider-key' }),
  getRequestBody: async () => JSON.stringify({ model: 'provider/model' }),
  maybeNormalizeOpenAIResponsesInput: (_service: unknown, _method: string, _path: string, body: unknown) => body,
  matchAllowedRoute: () => null,
  reserveToolProxyCredits: async () => null,
  refundToolReservation: async () => undefined,
  injectApiKey: () => undefined,
}));

const { handleProxy } = await import('./handlers');
const originalFetch = globalThis.fetch;

beforeEach(() => {
  reserveCalls = 0;
  settleCalls = 0;
  refundCalls = 0;
  globalThis.fetch = mock(async () => new Response(JSON.stringify({ model: 'provider/model' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })) as unknown as typeof fetch;
});

afterEach(() => { globalThis.fetch = originalFetch; });

describe('BYOK passthrough billing', () => {
  test('forwards an LLM response without touching Kortix credits', async () => {
    const context = { req: { url: 'https://api.example/v1/openai/chat/completions', method: 'POST' } };
    const service = {
      name: 'openai',
      targetBaseUrl: 'https://provider.example',
      billingToolName: 'llm',
      isLlm: true,
    };

    const response = await handleProxy(context, service as never, 'openai');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ model: 'provider/model' });
    expect({ reserveCalls, settleCalls, refundCalls }).toEqual({ reserveCalls: 0, settleCalls: 0, refundCalls: 0 });
  });
});
