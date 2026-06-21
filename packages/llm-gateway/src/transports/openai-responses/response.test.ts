import { describe, expect, test } from 'bun:test';

import { buildResponsesRequest, chatToResponses } from './request';
import { responsesJsonToChat, translateResponsesResponse } from './response';
import { transportFor } from '../registry';
import { callUpstream, type FetchImpl } from '../../http';
import { extractUsageFromSseBuffer } from '../../usage';
import type { UpstreamDescriptor } from '../../domain';

const codex: UpstreamDescriptor = {
  provider: 'openai-codex',
  kind: 'openai-responses',
  baseUrl: 'https://chatgpt.com/backend-api/codex',
  apiKey: 'oat_test',
  billingMode: 'none',
  markup: 0,
  resolvedModel: 'gpt-5-codex',
  headers: { 'ChatGPT-Account-ID': 'acct_1', originator: 'codex_cli_rs' },
};

const fastRetry = { sleep: async () => {}, rand: () => 0.5, baseDelayMs: 1, maxAttempts: 3 };

function sseResponse(events: unknown[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function dataChunks(sse: string): Record<string, unknown>[] {
  return sse
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter((p) => p && p !== '[DONE]')
    .map((p) => JSON.parse(p));
}

describe('chatToResponses', () => {
  test('maps system to instructions and messages to input', () => {
    const payload = chatToResponses(
      {
        model: 'codex/gpt-5-codex',
        messages: [
          { role: 'system', content: 'be terse' },
          { role: 'user', content: 'hi' },
        ],
        stream: true,
      },
      codex,
    );
    expect(payload.model).toBe('gpt-5-codex');
    expect(payload.instructions).toBe('be terse');
    expect(payload.input).toEqual([{ role: 'user', content: 'hi' }]);
    expect(payload.stream).toBe(true);
    expect(payload.store).toBe(false);
  });

  test('translates tools and reasoning_effort', () => {
    const payload = chatToResponses(
      {
        messages: [{ role: 'user', content: 'x' }],
        reasoning_effort: 'high',
        tools: [{ type: 'function', function: { name: 'get_weather', description: 'd', parameters: { type: 'object' } } }],
      },
      codex,
    );
    expect(payload.reasoning).toEqual({ effort: 'high' });
    expect(payload.tools).toEqual([{ type: 'function', name: 'get_weather', description: 'd', parameters: { type: 'object' } }]);
  });

  test('flattens assistant tool calls and tool results into input items', () => {
    const payload = chatToResponses(
      {
        messages: [
          { role: 'user', content: 'weather?' },
          { role: 'assistant', tool_calls: [{ id: 'call_1', function: { name: 'get_weather', arguments: '{}' } }] },
          { role: 'tool', tool_call_id: 'call_1', content: 'sunny' },
        ],
      },
      codex,
    );
    expect(payload.input).toEqual([
      { role: 'user', content: 'weather?' },
      { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'sunny' },
    ]);
  });
});

describe('buildResponsesRequest', () => {
  test('targets /responses with bearer + descriptor headers', () => {
    const request = buildResponsesRequest({ model: 'm', messages: [], stream: false }, codex);
    expect(request.url).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(request.headers.authorization).toBe('Bearer oat_test');
    expect(request.headers['ChatGPT-Account-ID']).toBe('acct_1');
  });
});

describe('responsesJsonToChat', () => {
  test('maps a non-streaming response into a chat completion', () => {
    const chat = responsesJsonToChat({
      id: 'resp_1',
      model: 'gpt-5-codex',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello' }] }],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 2 } },
    });
    expect(chat.object).toBe('chat.completion');
    const choices = chat.choices as Record<string, unknown>[];
    expect((choices[0].message as Record<string, unknown>).content).toBe('Hello');
    expect(choices[0].finish_reason).toBe('stop');
    expect(chat.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      prompt_tokens_details: { cached_tokens: 2 },
    });
  });

  test('surfaces tool calls with tool_calls finish reason', () => {
    const chat = responsesJsonToChat({
      output: [{ type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"sf"}' }],
    });
    const choices = chat.choices as Record<string, unknown>[];
    expect(choices[0].finish_reason).toBe('tool_calls');
    const toolCalls = (choices[0].message as Record<string, unknown>).tool_calls as Record<string, unknown>[];
    expect((toolCalls[0].function as Record<string, unknown>).name).toBe('get_weather');
  });
});

describe('translateResponsesResponse (streaming)', () => {
  test('translates a text stream into openai chunks with usage', async () => {
    const upstream = sseResponse([
      { type: 'response.created', response: { id: 'resp_1', model: 'gpt-5-codex' } },
      { type: 'response.output_text.delta', delta: 'Hello' },
      { type: 'response.output_text.delta', delta: ' world' },
      { type: 'response.completed', response: { model: 'gpt-5-codex', usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } },
    ]);

    const translated = await translateResponsesResponse(upstream, { streaming: true });
    const sse = await translated.text();
    expect(sse).toContain('data: [DONE]');

    const chunks = dataChunks(sse);
    const text = chunks.map((c) => ((c.choices as Record<string, unknown>[])[0].delta as Record<string, unknown>).content ?? '').join('');
    expect(text).toBe('Hello world');

    const usage = extractUsageFromSseBuffer(sse);
    expect(usage?.promptTokens).toBe(10);
    expect(usage?.completionTokens).toBe(2);
    expect(usage?.model).toBe('gpt-5-codex');
  });

  test('translates streamed tool calls into tool_call deltas', async () => {
    const upstream = sseResponse([
      { type: 'response.created', response: { id: 'resp_2', model: 'gpt-5-codex' } },
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"city":' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '"sf"}' },
      { type: 'response.completed', response: { model: 'gpt-5-codex', usage: { input_tokens: 4, output_tokens: 6 } } },
    ]);

    const translated = await translateResponsesResponse(upstream, { streaming: true });
    const chunks = dataChunks(await translated.text());

    const args = chunks
      .flatMap((c) => ((c.choices as Record<string, unknown>[])[0].delta as Record<string, unknown>).tool_calls as Record<string, unknown>[] | undefined ?? [])
      .map((tc) => (tc.function as Record<string, unknown> | undefined)?.arguments ?? '')
      .join('');
    expect(args).toBe('{"city":"sf"}');

    const final = chunks[chunks.length - 1];
    expect((final.choices as Record<string, unknown>[])[0].finish_reason).toBe('tool_calls');
  });
});

describe('callUpstream with openai-responses transport', () => {
  test('builds a responses request and returns translated openai chunks', async () => {
    let seenUrl = '';
    let seenBody: Record<string, unknown> = {};
    const fetchImpl: FetchImpl = async (url, init) => {
      seenUrl = url;
      seenBody = JSON.parse(String(init.body));
      return sseResponse([
        { type: 'response.created', response: { id: 'resp_3', model: 'gpt-5-codex' } },
        { type: 'response.output_text.delta', delta: 'hi' },
        { type: 'response.completed', response: { model: 'gpt-5-codex', usage: { input_tokens: 1, output_tokens: 1 } } },
      ]);
    };

    const res = await callUpstream(
      { model: 'codex/gpt-5-codex', messages: [{ role: 'user', content: 'yo' }], stream: true },
      codex,
      { fetchImpl, retry: fastRetry },
    );

    expect(seenUrl).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(seenBody.input).toEqual([{ role: 'user', content: 'yo' }]);

    const chunks = dataChunks(await res.text());
    expect(chunks[0].object).toBe('chat.completion.chunk');
    expect(extractUsageFromSseBuffer('')).toBeNull();
  });
});

describe('transportFor', () => {
  test('returns a distinct transport per kind, falling back to openai-compat', () => {
    expect(transportFor('openai-responses')).not.toBe(transportFor('openai-compat'));
    expect(transportFor('anthropic')).not.toBe(transportFor('openai-compat'));
    expect(transportFor('custom')).toBe(transportFor('openai-compat'));
  });
});
