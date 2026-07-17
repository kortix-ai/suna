import { describe, expect, test } from 'bun:test';

import {
  anthropicMessagesToChat,
  chatJsonToAnthropicMessage,
  chatSseToAnthropicSse,
} from './anthropic-messages';

describe('anthropicMessagesToChat', () => {
  test('maps a string system prompt to an OpenAI system message', () => {
    const out = anthropicMessagesToChat({
      model: 'claude-sonnet-4-6',
      system: 'be nice',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(out.messages).toEqual([
      { role: 'system', content: 'be nice' },
      { role: 'user', content: 'hi' },
    ]);
    expect(out.model).toBe('claude-sonnet-4-6');
    expect(out.stream).toBe(false);
  });

  test('maps a content-block system prompt to an OpenAI system message', () => {
    const out = anthropicMessagesToChat({
      model: 'claude-sonnet-4-6',
      system: [
        { type: 'text', text: 'part one' },
        { type: 'text', text: 'part two' },
      ],
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(out.messages).toEqual([
      { role: 'system', content: 'part onepart two' },
      { role: 'user', content: 'hi' },
    ]);
  });

  test('omits the system message entirely when none is set', () => {
    const out = anthropicMessagesToChat({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(out.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  test('maps an assistant tool_use content block to OpenAI tool_calls', () => {
    const out = anthropicMessagesToChat({
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'user', content: 'what is the weather in paris?' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'let me check' },
            { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'paris' } },
          ],
        },
      ],
    });
    expect(out.messages).toEqual([
      { role: 'user', content: 'what is the weather in paris?' },
      {
        role: 'assistant',
        content: 'let me check',
        tool_calls: [
          {
            id: 'tu_1',
            type: 'function',
            function: { name: 'get_weather', arguments: JSON.stringify({ city: 'paris' }) },
          },
        ],
      },
    ]);
  });

  test('maps a user tool_result content block to an OpenAI role:tool message before any remaining user text', () => {
    const out = anthropicMessagesToChat({
      model: 'claude-sonnet-4-6',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu_1', content: '18C and sunny' },
            { type: 'text', text: 'thanks, what about tomorrow?' },
          ],
        },
      ],
    });
    expect(out.messages).toEqual([
      { role: 'tool', tool_call_id: 'tu_1', content: '18C and sunny' },
      { role: 'user', content: 'thanks, what about tomorrow?' },
    ]);
  });

  test('flattens a tool_result whose content is itself a block array', () => {
    const out = anthropicMessagesToChat({
      model: 'claude-sonnet-4-6',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_1',
              content: [{ type: 'text', text: '18C and sunny' }],
            },
          ],
        },
      ],
    });
    expect(out.messages).toEqual([
      { role: 'tool', tool_call_id: 'tu_1', content: '18C and sunny' },
    ]);
  });

  test('translates tools (input_schema -> parameters)', () => {
    const out = anthropicMessagesToChat({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'go' }],
      tools: [
        {
          name: 'get_weather',
          description: 'looks up the weather',
          input_schema: { type: 'object', properties: { city: { type: 'string' } } },
        },
      ],
    });
    expect(out.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'looks up the weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
      },
    ]);
  });

  test('translates tool_choice variants', () => {
    const base = {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user' as const, content: 'go' }],
    };
    expect(anthropicMessagesToChat({ ...base, tool_choice: { type: 'auto' } }).tool_choice).toBe(
      'auto',
    );
    expect(anthropicMessagesToChat({ ...base, tool_choice: { type: 'any' } }).tool_choice).toBe(
      'required',
    );
    expect(anthropicMessagesToChat({ ...base, tool_choice: { type: 'none' } }).tool_choice).toBe(
      'none',
    );
    expect(
      anthropicMessagesToChat({ ...base, tool_choice: { type: 'tool', name: 'get_weather' } })
        .tool_choice,
    ).toEqual({ type: 'function', function: { name: 'get_weather' } });
  });

  test('maps max_tokens, temperature, top_p, and stop_sequences', () => {
    const out = anthropicMessagesToChat({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'go' }],
      max_tokens: 512,
      temperature: 0.4,
      top_p: 0.9,
      stop_sequences: ['STOP'],
    });
    expect(out.max_tokens).toBe(512);
    expect(out.temperature).toBe(0.4);
    expect(out.top_p).toBe(0.9);
    expect(out.stop).toEqual(['STOP']);
  });

  test('carries stream through unchanged', () => {
    const out = anthropicMessagesToChat({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'go' }],
      stream: true,
    });
    expect(out.stream).toBe(true);
  });
});

describe('chatJsonToAnthropicMessage', () => {
  test('maps a plain-text OpenAI completion to an Anthropic message', () => {
    const out = chatJsonToAnthropicMessage({
      id: 'chatcmpl-abc',
      model: 'claude-sonnet-4-6',
      choices: [
        { index: 0, message: { role: 'assistant', content: 'hello there' }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
    });
    expect(out).toMatchObject({
      id: 'msg_chatcmpl-abc',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: 'hello there' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 12, output_tokens: 3 },
    });
  });

  test('maps an OpenAI tool_call to an Anthropic tool_use block, finish_reason tool_calls -> tool_use', () => {
    const out = chatJsonToAnthropicMessage({
      id: 'chatcmpl-abc',
      model: 'claude-sonnet-4-6',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"city":"paris"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
    });
    expect(out.stop_reason).toBe('tool_use');
    expect(out.content).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'paris' } },
    ]);
  });

  test('maps finish_reason length -> max_tokens', () => {
    const out = chatJsonToAnthropicMessage({
      id: 'chatcmpl-abc',
      model: 'claude-sonnet-4-6',
      choices: [
        { index: 0, message: { role: 'assistant', content: 'partial' }, finish_reason: 'length' },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    expect(out.stop_reason).toBe('max_tokens');
  });

  test('defaults usage to zero when the OpenAI body omits it', () => {
    const out = chatJsonToAnthropicMessage({
      id: 'chatcmpl-abc',
      model: 'claude-sonnet-4-6',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    });
    expect(out.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });
});

function encodeSse(...lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(lines.join('')));
      controller.close();
    },
  });
}

interface AnthropicSseEventData {
  type: string;
  index?: number;
  message?: Record<string, unknown>;
  content_block?: Record<string, unknown>;
  delta?: Record<string, unknown>;
  usage?: Record<string, unknown>;
  error?: Record<string, unknown>;
}

async function collectAnthropicEvents(
  stream: ReadableStream<Uint8Array>,
): Promise<{ event: string; data: AnthropicSseEventData }[]> {
  const text = await new Response(stream).text();
  const events: { event: string; data: AnthropicSseEventData }[] = [];
  for (const block of text.split('\n\n')) {
    if (!block.trim()) continue;
    const lines = block.split('\n');
    const eventLine = lines.find((l) => l.startsWith('event:'));
    const dataLine = lines.find((l) => l.startsWith('data:'));
    if (!eventLine || !dataLine) continue;
    events.push({ event: eventLine.slice(6).trim(), data: JSON.parse(dataLine.slice(5).trim()) });
  }
  return events;
}

function chunk(delta: Record<string, unknown>, finish: string | null = null): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-xyz',
    object: 'chat.completion.chunk',
    model: 'claude-sonnet-4-6',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

describe('chatSseToAnthropicSse', () => {
  test('translates a text-only OpenAI stream into the Anthropic event sequence', async () => {
    const openai = encodeSse(
      chunk({ role: 'assistant', content: '' }),
      chunk({ content: 'Hello' }),
      chunk({ content: ' world' }),
      chunk({}, 'stop'),
      `data: ${JSON.stringify({
        id: 'chatcmpl-xyz',
        model: 'claude-sonnet-4-6',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 },
      })}\n\n`,
      'data: [DONE]\n\n',
    );

    const events = await collectAnthropicEvents(
      chatSseToAnthropicSse(openai, { model: 'claude-sonnet-4-6' }),
    );
    const types = events.map((e) => e.event);
    expect(types).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);

    expect(events[0].data.message).toMatchObject({
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-6',
    });
    expect(events[1].data).toMatchObject({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text' },
    });
    expect(events[2].data.delta).toEqual({ type: 'text_delta', text: 'Hello' });
    expect(events[3].data.delta).toEqual({ type: 'text_delta', text: ' world' });
    expect(events[4].data).toEqual({ type: 'content_block_stop', index: 0 });
    expect(events[5].data.delta?.stop_reason).toBe('end_turn');
    expect(events[5].data.usage?.output_tokens).toBe(2);
    expect(events[6].data).toEqual({ type: 'message_stop' });
  });

  test('translates an OpenAI tool_call stream into a tool_use content block with input_json_delta', async () => {
    const openai = encodeSse(
      chunk({ role: 'assistant', content: '' }),
      chunk({
        tool_calls: [
          {
            index: 0,
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '' },
          },
        ],
      }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"paris"}' } }] }),
      chunk({}, 'tool_calls'),
      'data: [DONE]\n\n',
    );

    const events = await collectAnthropicEvents(chatSseToAnthropicSse(openai));
    const types = events.map((e) => e.event);
    expect(types).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);

    expect(events[1].data.content_block).toMatchObject({
      type: 'tool_use',
      id: 'call_1',
      name: 'get_weather',
      input: {},
    });
    expect(events[2].data.delta).toEqual({ type: 'input_json_delta', partial_json: '{"city":' });
    expect(events[3].data.delta).toEqual({ type: 'input_json_delta', partial_json: '"paris"}' });
    expect(events[4].data).toEqual({ type: 'content_block_stop', index: 0 });
    expect(events[5].data.delta?.stop_reason).toBe('tool_use');
  });

  test('closes the text block before opening a tool_use block in a mixed text+tool stream', async () => {
    const openai = encodeSse(
      chunk({ role: 'assistant', content: '' }),
      chunk({ content: 'checking the weather' }),
      chunk({
        tool_calls: [
          {
            index: 0,
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{}' },
          },
        ],
      }),
      chunk({}, 'tool_calls'),
      'data: [DONE]\n\n',
    );

    const events = await collectAnthropicEvents(chatSseToAnthropicSse(openai));
    const types = events.map((e) => e.event);
    expect(types).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    expect(events[1].data.index).toBe(0);
    expect(events[4].data.index).toBe(1);
    expect(events[4].data.content_block?.type).toBe('tool_use');
  });

  test('translates a mid-stream OpenAI error frame into an Anthropic error event without dropping the connection', async () => {
    const openai = encodeSse(
      chunk({ role: 'assistant', content: '' }),
      `data: ${JSON.stringify({ error: { message: 'Overloaded', type: 'overloaded_error' } })}\n\n`,
    );

    const events = await collectAnthropicEvents(chatSseToAnthropicSse(openai));
    const errorEvent = events.find((e) => e.event === 'error');
    expect(errorEvent?.data.error).toEqual({ type: 'overloaded_error', message: 'Overloaded' });
    expect(events.at(-1)?.event).toBe('message_stop');
  });

  test('always terminates with message_stop even for an empty stream', async () => {
    const openai = encodeSse('data: [DONE]\n\n');
    const events = await collectAnthropicEvents(chatSseToAnthropicSse(openai));
    expect(events.map((e) => e.event)).toEqual(['message_start', 'message_delta', 'message_stop']);
  });
});
