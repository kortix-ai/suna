import { describe, expect, test } from 'bun:test';

import { buildAnthropicRequest } from './request';
import { translateAnthropicResponse } from './response';
import type { UpstreamDescriptor } from '../../domain';

const descriptor: UpstreamDescriptor = {
  provider: 'anthropic',
  kind: 'anthropic',
  baseUrl: 'https://api.anthropic.com/v1',
  apiKey: 'sk-ant-test',
  billingMode: 'none',
  markup: 1,
  resolvedModel: 'claude-sonnet-4-6',
};

describe('buildAnthropicRequest', () => {
  test('maps an OpenAI chat body to the Anthropic Messages API', () => {
    const req = buildAnthropicRequest(
      {
        model: 'anthropic/claude-sonnet-4-6',
        messages: [
          { role: 'system', content: 'be nice' },
          { role: 'user', content: 'hi' },
        ],
        temperature: 0.5,
        stream: true,
      },
      descriptor,
    );
    expect(req.url).toBe('https://api.anthropic.com/v1/messages');
    expect(req.headers['x-api-key']).toBe('sk-ant-test');
    expect(req.headers['anthropic-version']).toBeTruthy();
    expect(req.payload.model).toBe('claude-sonnet-4-6');
    expect(req.payload.system).toBe('be nice');
    expect(req.payload.max_tokens).toBeGreaterThan(0);
    expect(req.payload.stream).toBe(true);
    expect(req.payload.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  test('normalizes dotted catalog ids to Anthropic dashed model names', () => {
    const req = buildAnthropicRequest(
      { messages: [{ role: 'user', content: 'hi' }] },
      { ...descriptor, resolvedModel: 'claude-sonnet-4.6' },
    );
    expect(req.payload.model).toBe('claude-sonnet-4-6');
  });

  test('translates OpenAI tools to Anthropic tools', () => {
    const req = buildAnthropicRequest(
      {
        messages: [{ role: 'user', content: 'go' }],
        tools: [
          { type: 'function', function: { name: 'search', description: 'd', parameters: { type: 'object' } } },
        ],
      },
      descriptor,
    );
    expect((req.payload.tools as any[])[0]).toMatchObject({ name: 'search', description: 'd' });
  });
});

describe('translateAnthropicResponse (non-streaming)', () => {
  test('maps an Anthropic message to an OpenAI chat completion with usage', async () => {
    const anthropic = new Response(
      JSON.stringify({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: 'hello there' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 12, output_tokens: 3 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
    const out = await translateAnthropicResponse(anthropic, { streaming: false });
    const body = (await out.json()) as any;
    expect(body.object).toBe('chat.completion');
    expect(body.choices[0].message.content).toBe('hello there');
    expect(body.choices[0].finish_reason).toBe('stop');
    expect(body.usage).toEqual({ prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 });
  });

  test('maps a tool_use block to OpenAI tool_calls', async () => {
    const anthropic = new Response(
      JSON.stringify({
        id: 'msg_2',
        model: 'claude-sonnet-4-6',
        content: [{ type: 'tool_use', id: 'tu_1', name: 'search', input: { q: 'x' } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 5, output_tokens: 7 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
    const out = await translateAnthropicResponse(anthropic, { streaming: false });
    const body = (await out.json()) as any;
    expect(body.choices[0].finish_reason).toBe('tool_calls');
    expect(body.choices[0].message.tool_calls[0]).toMatchObject({
      id: 'tu_1',
      type: 'function',
      function: { name: 'search', arguments: JSON.stringify({ q: 'x' }) },
    });
  });
});
