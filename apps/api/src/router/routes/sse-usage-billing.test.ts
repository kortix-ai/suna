import { describe, expect, mock, test } from 'bun:test';

// Characterization tests for the streamed-billing path of the two LLM routes.
// They pin the settled usage values (prompt/completion/cached/cacheWrite tokens
// and the exact upstream cost) for an OpenAI-shaped and an Anthropic-shaped SSE
// stream. They must pass before and after the shared `consumeSseUsage` +
// `settleStreamUsage` extraction.

const settleCalls: any[] = [];
const refundCalls: string[] = [];

mock.module('../../config', () => ({
  config: {
    KORTIX_BILLING_INTERNAL_ENABLED: true,
    OPENROUTER_API_URL: 'https://openrouter.example',
  },
  KORTIX_MARKUP: 1.2,
}));

mock.module('../services/llm-reservation', () => ({
  reserveEstimatedLlmCredits: async () => null,
  settleLlmReservation: async (input: any) => {
    settleCalls.push(input);
  },
  refundLlmReservation: async (_reservation: unknown, description: string) => {
    refundCalls.push(description);
  },
}));

mock.module('./proxy/helpers', () => ({
  tryAuthenticate: async () => ({
    isKortixUser: true,
    isPassthrough: true,
    accountId: 'acct-synthetic',
  }),
  buildForwardHeaders: () => new Headers(),
  getRequestBody: async () => '{}',
  maybeNormalizeOpenAIResponsesInput: (_s: unknown, _m: string, _p: string, body: unknown) => body,
  matchAllowedRoute: () => null,
  reserveToolProxyCredits: async () => null,
  refundToolReservation: async () => undefined,
  injectApiKey: () => undefined,
}));

const { extractUsageFromStream } = await import('./llm');
const { extractUsageFromKortixProxyStream } = await import('./proxy/handlers');

const MODEL_CONFIG = {
  openrouterId: 'synthetic-model',
  inputPer1M: 1,
  outputPer1M: 4,
  contextWindow: 128_000,
  tier: 'paid' as const,
};

function sse(...events: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const body = events.map((event) => `data: ${event}\n\n`).join('');
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
}

// Both shapes carry the same usage: 140 prompt (80 cached + 20 cache-write +
// 40 plain), 30 completion, exact upstream cost 0.00042.
const OPENAI_USAGE = JSON.stringify({
  model: 'synthetic-model',
  usage: {
    prompt_tokens: 140,
    completion_tokens: 30,
    prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 20 },
    cost: 0.00042,
  },
});

const ANTHROPIC_START = JSON.stringify({
  type: 'message_start',
  message: {
    model: 'synthetic-model',
    usage: {
      input_tokens: 40,
      cache_read_input_tokens: 80,
      cache_creation_input_tokens: 20,
      cost: 0.00042,
    },
  },
});

const ANTHROPIC_DELTA = JSON.stringify({
  type: 'message_delta',
  usage: { output_tokens: 30 },
});

const EXPECTED_USAGE = {
  promptTokens: 140,
  completionTokens: 30,
  cachedTokens: 80,
  cacheWriteTokens: 20,
  upstreamCost: 0.00042,
  actualCost: 0.000504,
};

function reset() {
  settleCalls.length = 0;
  refundCalls.length = 0;
}

function reservation() {
  return { modelConfig: MODEL_CONFIG } as never;
}

describe('streamed LLM usage billing', () => {
  test('the router route settles the OpenAI-shaped usage with cache and upstream cost', async () => {
    reset();
    await extractUsageFromStream(
      sse(OPENAI_USAGE),
      MODEL_CONFIG,
      'synthetic-model',
      'acct-synthetic',
      'session-synthetic',
      null,
      reservation(),
    );
    expect(settleCalls).toHaveLength(1);
    expect(settleCalls[0]).toMatchObject({
      ...EXPECTED_USAGE,
      modelId: 'synthetic-model',
      streaming: true,
      upstreamStatus: 200,
      provider: 'openrouter',
      route: '/v1/router/chat/completions',
      sessionId: 'session-synthetic',
    });
    expect(refundCalls).toEqual([]);
  });

  test('the proxy route settles the OpenAI-shaped usage', async () => {
    reset();
    await extractUsageFromKortixProxyStream(
      sse(OPENAI_USAGE),
      { name: 'openai' } as never,
      '/chat/completions',
      'acct-synthetic',
      null,
      reservation(),
    );
    expect(settleCalls).toHaveLength(1);
    expect(settleCalls[0]).toMatchObject({
      ...EXPECTED_USAGE,
      modelId: 'synthetic-model',
      streaming: true,
      upstreamStatus: 200,
      provider: 'openai',
      route: '/v1/openai/chat/completions',
    });
    expect(refundCalls).toEqual([]);
  });

  test('the proxy route settles the Anthropic-shaped usage with cache and upstream cost', async () => {
    reset();
    await extractUsageFromKortixProxyStream(
      sse(ANTHROPIC_START, ANTHROPIC_DELTA),
      { name: 'anthropic' } as never,
      '/messages',
      'acct-synthetic',
      null,
      reservation(),
    );
    expect(settleCalls).toHaveLength(1);
    expect(settleCalls[0]).toMatchObject({
      ...EXPECTED_USAGE,
      modelId: 'synthetic-model',
      streaming: true,
      upstreamStatus: 200,
      provider: 'anthropic',
      route: '/v1/anthropic/messages',
    });
    expect(refundCalls).toEqual([]);
  });

  test('the two provider shapes settle identical usage values', async () => {
    reset();
    await extractUsageFromKortixProxyStream(
      sse(OPENAI_USAGE),
      { name: 'openai' } as never,
      '/chat/completions',
      'acct-synthetic',
      null,
      reservation(),
    );
    await extractUsageFromKortixProxyStream(
      sse(ANTHROPIC_START, ANTHROPIC_DELTA),
      { name: 'anthropic' } as never,
      '/messages',
      'acct-synthetic',
      null,
      reservation(),
    );
    expect(settleCalls).toHaveLength(2);
    const usage = (call: any) => ({
      promptTokens: call.promptTokens,
      completionTokens: call.completionTokens,
      cachedTokens: call.cachedTokens,
      cacheWriteTokens: call.cacheWriteTokens,
      upstreamCost: call.upstreamCost,
      actualCost: call.actualCost,
    });
    expect(usage(settleCalls[0])).toEqual(usage(settleCalls[1]));
  });

  test('a stream with no usage refunds instead of settling', async () => {
    reset();
    await extractUsageFromKortixProxyStream(
      sse(JSON.stringify({ model: 'synthetic-model', choices: [] })),
      { name: 'openai' } as never,
      '/chat/completions',
      'acct-synthetic',
      null,
      reservation(),
    );
    expect(settleCalls).toEqual([]);
    expect(refundCalls).toHaveLength(1);
  });
});
