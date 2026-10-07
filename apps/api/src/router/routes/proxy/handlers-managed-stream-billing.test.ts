import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

// A Kortix-managed OpenAI chat stream, end to end through handleProxy: the body
// sent upstream asks for usage, and a stream that still reports none settles at
// the held amount instead of refunding it.

const held: unknown[] = [];
const settled: Array<Record<string, unknown>> = [];
const refunded: string[] = [];
let upstreamBodies: Array<Record<string, unknown>> = [];

const modelConfig = { openrouterId: 'm', inputPer1M: 3.3, outputPer1M: 16.5, contextWindow: 1, tier: 'paid' as const };
const reservation = {
  accountId: 'acct-synthetic', modelId: 'gpt-test', promptTokens: 500, completionTokens: 4096,
  cost: 0.0831, modelConfig, pricingProvider: 'openai',
};

mock.module('../../services/llm-reservation', () => ({
  reserveEstimatedLlmCredits: async () => reservation,
  settleLlmReservation: async (input: Record<string, unknown>) => { settled.push(input); },
  settleHeldLlmReservation: async (input: unknown) => { held.push(input); },
  refundLlmReservation: async (_r: unknown, description: string) => { refunded.push(description); },
}));

const realHelpers = await import('./helpers');
mock.module('./helpers', () => ({
  ...realHelpers,
  tryAuthenticate: async () => ({ isKortixUser: true, accountId: 'acct-synthetic' }),
}));

const { handleProxy } = await import('./handlers');
const originalFetch = globalThis.fetch;

const openai = {
  name: 'openai',
  targetBaseUrl: 'https://api.openai.example',
  getKortixApiKey: () => 'kortix-managed-key',
  keyInjection: { type: 'header' as const, headerName: 'Authorization', prefix: 'Bearer ' },
  allowedRoutes: [{ path: '/v1/chat/completions', methods: ['POST'] }],
  billingToolName: 'proxy_openai',
  isLlm: true,
};

function context(body: unknown) {
  const raw = new Request('https://api.example/v1/router/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer kortix_pat_synthetic' },
    body: JSON.stringify(body),
  });
  return { req: { url: raw.url, method: 'POST', header: () => undefined, raw } } as never;
}

function sse(...frames: unknown[]): Response {
  const text = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(text, { headers: { 'content-type': 'text/event-stream' } });
}

beforeEach(() => {
  held.length = 0; settled.length = 0; refunded.length = 0; upstreamBodies = [];
});
afterEach(() => { globalThis.fetch = originalFetch; });

async function run(upstream: Response) {
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    upstreamBodies.push(JSON.parse(String(init?.body)));
    return upstream;
  }) as unknown as typeof fetch;
  const response = await handleProxy(
    context({ model: 'gpt-test', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    openai as never,
    'openai',
  );
  await response.text(); // the client drains; the tee'd billing copy settles in the background
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe('managed OpenAI chat stream billing', () => {
  test('the upstream request asks for usage', async () => {
    await run(sse({ model: 'gpt-test', choices: [], usage: { prompt_tokens: 1000, completion_tokens: 200 } }));
    expect(upstreamBodies[0]!.stream_options).toEqual({ include_usage: true });
    expect(settled).toHaveLength(1);
    expect(held).toHaveLength(0);
    expect(refunded).toHaveLength(0);
  });

  test('a stream that reports no usage keeps the held amount: no refund', async () => {
    await run(sse({ model: 'gpt-test', choices: [{ delta: { content: 'free answer' } }] }));
    expect(held).toHaveLength(1);
    expect(settled).toHaveLength(0);
    expect(refunded).toHaveLength(0);
  });
});
