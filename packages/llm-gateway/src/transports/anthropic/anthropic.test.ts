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
    expect(req.payload.system).toEqual([
      { type: 'text', text: 'be nice', cache_control: { type: 'ephemeral' } },
    ]);
    expect(req.payload.max_tokens).toBeGreaterThan(0);
    expect(req.payload.stream).toBe(true);
    expect(req.payload.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] },
    ]);
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

describe('buildAnthropicRequest — prompt caching', () => {
  test('marks system, the last tool, and the conversation tail as cacheable', () => {
    const req = buildAnthropicRequest(
      {
        messages: [
          { role: 'system', content: 'a long stable system prompt' },
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'ok' },
          { role: 'user', content: 'second' },
        ],
        tools: [
          { type: 'function', function: { name: 'a', parameters: { type: 'object' } } },
          { type: 'function', function: { name: 'b', parameters: { type: 'object' } } },
        ],
      },
      descriptor,
    );
    const p = req.payload as any;
    expect(p.system).toEqual([
      { type: 'text', text: 'a long stable system prompt', cache_control: { type: 'ephemeral' } },
    ]);
    expect(p.tools[0].cache_control).toBeUndefined();
    expect(p.tools[1].cache_control).toEqual({ type: 'ephemeral' });
    const lastMsg = p.messages[p.messages.length - 1];
    expect(lastMsg.content).toEqual([
      { type: 'text', text: 'second', cache_control: { type: 'ephemeral' } },
    ]);
    const firstUser = p.messages[0];
    expect(firstUser.content).toBe('first');
  });

  test('adds the breakpoint to the final block of an array-content tail message', () => {
    const req = buildAnthropicRequest(
      {
        messages: [
          { role: 'user', content: 'hi' },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'look' },
              { type: 'text', text: 'at this' },
            ],
          },
        ],
      },
      descriptor,
    );
    const tail = (req.payload as any).messages.at(-1).content;
    expect(tail[0].cache_control).toBeUndefined();
    expect(tail[1].cache_control).toEqual({ type: 'ephemeral' });
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
