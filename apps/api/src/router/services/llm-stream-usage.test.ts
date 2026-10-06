import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Router stream settlement. A delivered stream is never free: a stream with no
// usage frame settles at the held amount, never at a refund.

const settled: Array<Record<string, unknown>> = [];
const held: Array<Record<string, unknown>> = [];
const refunded: string[] = [];

mock.module('./llm-reservation', () => ({
  settleLlmReservation: async (input: Record<string, unknown>) => { settled.push(input); },
  settleHeldLlmReservation: async (input: Record<string, unknown>) => { held.push(input); },
  refundLlmReservation: async (_r: unknown, description: string) => { refunded.push(description); },
}));

const { forceStreamUsage, settleStreamUsage } = await import('./llm');

// $3.30 / M input, $16.50 / M output, markup 1.2 (KORTIX_MARKUP).
const modelConfig = {
  openrouterId: 'stream-test-model',
  inputPer1M: 3.3,
  outputPer1M: 16.5,
  contextWindow: 128_000,
  tier: 'paid' as const,
};
// (1000 * 3.3 + 200 * 16.5) / 1e6 = 0.0066 ; * 1.2 = 0.00792
const EXPECTED_COST = 0.00792;

const reservation = {
  accountId: 'acct-synthetic',
  modelId: 'stream-test-model',
  promptTokens: 500,
  completionTokens: 4096,
  cost: 0.0831,
  modelConfig,
  pricingProvider: 'openrouter',
};

function sse(...frames: unknown[]): ReadableStream<Uint8Array> {
  const text = frames
    .map((f) => (f === '[DONE]' ? 'data: [DONE]\n\n' : `data: ${JSON.stringify(f)}\n\n`))
    .join('');
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function run(stream: ReadableStream<Uint8Array>, provider: 'openai' | 'anthropic' = 'openai', res: typeof reservation | null = reservation) {
  return settleStreamUsage({
    stream,
    provider,
    accountId: 'acct-synthetic',
    actor: null,
    reservation: res,
    modelId: 'stream-test-model',
    modelConfig,
    pricingProvider: 'openrouter',
    route: '/v1/test',
    logPrefix: 'test',
    noUsageWarning: 'no usage',
    errorRefund: 'error refund',
    scanErrorLog: 'scan error',
    refundFailedLog: 'refund failed',
    successLog: () => 'ok',
  });
}

beforeEach(() => {
  settled.length = 0;
  held.length = 0;
  refunded.length = 0;
});

describe('router stream settlement', () => {
  test('chat completions stream with a usage frame settles at the real cost', async () => {
    await run(sse(
      { model: 'm', choices: [{ delta: { content: 'hi' } }] },
      { model: 'm', choices: [], usage: { prompt_tokens: 1000, completion_tokens: 200 } },
      '[DONE]',
    ));
    expect(settled).toHaveLength(1);
    expect(settled[0]!.actualCost).toBeCloseTo(EXPECTED_COST, 8);
    expect(held).toHaveLength(0);
    expect(refunded).toHaveLength(0);
  });

  test('Responses stream reads usage from response.completed', async () => {
    await run(sse(
      { type: 'response.output_text.delta', delta: 'hi' },
      {
        type: 'response.completed',
        response: { model: 'm', usage: { input_tokens: 1000, output_tokens: 200, input_tokens_details: { cached_tokens: 0 } } },
      },
    ));
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ promptTokens: 1000, completionTokens: 200 });
    expect(settled[0]!.actualCost).toBeCloseTo(EXPECTED_COST, 8);
    expect(refunded).toHaveLength(0);
  });

  test('Anthropic stream settles from message_start + message_delta', async () => {
    await run(sse(
      { type: 'message_start', message: { model: 'm', usage: { input_tokens: 1000, output_tokens: 1 } } },
      { type: 'message_delta', usage: { output_tokens: 200 } },
    ), 'anthropic');
    expect(settled[0]).toMatchObject({ promptTokens: 1000, completionTokens: 200 });
    expect(settled[0]!.actualCost).toBeCloseTo(EXPECTED_COST, 8);
  });

  test('a delivered stream with no usage frame keeps the held amount and refunds nothing', async () => {
    await run(sse(
      { model: 'm', choices: [{ delta: { content: 'a free answer' } }] },
      '[DONE]',
    ));
    expect(held).toHaveLength(1);
    expect(held[0]!.reservation).toBe(reservation);
    expect(settled).toHaveLength(0);
    expect(refunded).toHaveLength(0);
  });

  test('a stream that breaks after bytes arrived keeps the held amount', async () => {
    let sent = false;
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"x"}}]}\n\n'));
          return;
        }
        controller.error(new Error('upstream reset'));
      },
    });
    await run(broken);
    expect(held).toHaveLength(1);
    expect(refunded).toHaveLength(0);
  });

  test('a stream that fails before any byte refunds the reservation', async () => {
    const dead = new ReadableStream<Uint8Array>({ start: (c) => c.error(new Error('reset')) });
    await run(dead);
    expect(held).toHaveLength(0);
    expect(refunded).toEqual(['error refund']);
  });
});

describe('forceStreamUsage', () => {
  test('adds include_usage to a chat completions stream and keeps other stream_options', () => {
    const out = forceStreamUsage(JSON.stringify({ model: 'm', stream: true, messages: [], stream_options: { x: 1 } }));
    expect(JSON.parse(out as string).stream_options).toEqual({ x: 1, include_usage: true });
  });

  test('overrides include_usage:false', () => {
    const out = forceStreamUsage(JSON.stringify({ model: 'm', stream: true, messages: [], stream_options: { include_usage: false } }));
    expect(JSON.parse(out as string).stream_options.include_usage).toBe(true);
  });

  test('leaves a non-stream body and a Responses body unchanged', () => {
    const plain = JSON.stringify({ model: 'm', messages: [] });
    expect(forceStreamUsage(plain)).toBe(plain);
    const responses = JSON.stringify({ model: 'm', stream: true, input: 'hi' });
    expect(forceStreamUsage(responses)).toBe(responses);
  });
});
