import { describe, expect, test } from 'bun:test';

import {
  chatJsonToResponsesObject,
  chatSseToResponsesSse,
  responsesToChat,
} from './openai-responses';

describe('responsesToChat', () => {
  test('maps a plain string input to a single user message', () => {
    const out = responsesToChat({ model: 'codex/gpt-6-sol', input: 'hi' });
    expect(out.model).toBe('codex/gpt-6-sol');
    expect(out.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(out.stream).toBe(false);
  });

  test('maps instructions to a system message ahead of the input items', () => {
    const out = responsesToChat({
      model: 'codex/gpt-6-sol',
      instructions: 'be nice',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    });
    expect(out.messages).toEqual([
      { role: 'system', content: 'be nice' },
      { role: 'user', content: 'hi' },
    ]);
  });

  test('folds consecutive function_call items into one assistant message with multiple tool_calls', () => {
    const out = responsesToChat({
      model: 'codex/gpt-6-sol',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'list files then read one' }] },
        { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{"cmd":"ls"}' },
        { type: 'function_call', call_id: 'call_2', name: 'shell', arguments: '{"cmd":"cat a.txt"}' },
      ],
    });
    expect(out.messages).toEqual([
      { role: 'user', content: 'list files then read one' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'shell', arguments: '{"cmd":"ls"}' } },
          { id: 'call_2', type: 'function', function: { name: 'shell', arguments: '{"cmd":"cat a.txt"}' } },
        ],
      },
    ]);
  });

  test('maps a function_call_output item to a role:tool message', () => {
    const out = responsesToChat({
      model: 'codex/gpt-6-sol',
      input: [{ type: 'function_call_output', call_id: 'call_1', output: 'file1.txt\nfile2.txt' }],
    });
    expect(out.messages).toEqual([{ role: 'tool', tool_call_id: 'call_1', content: 'file1.txt\nfile2.txt' }]);
  });

  test('drops reasoning input items (no chat.completions equivalent)', () => {
    const out = responsesToChat({
      model: 'codex/gpt-6-sol',
      input: [
        { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque' },
        { type: 'message', role: 'user', content: 'hi' },
      ],
    });
    expect(out.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  test('maps nested reasoning.effort to both the nested and flat reasoning_effort fields', () => {
    const out = responsesToChat({ model: 'codex/gpt-6-sol', input: 'hi', reasoning: { effort: 'high', summary: 'auto' } });
    expect(out.reasoning).toEqual({ effort: 'high', summary: 'auto' });
    expect(out.reasoning_effort).toBe('high');
  });

  test('flattens Responses tools ({type,name,parameters}) to chat.completions {type,function:{name,parameters}}', () => {
    const out = responsesToChat({
      model: 'codex/gpt-6-sol',
      input: 'hi',
      tools: [{ type: 'function', name: 'shell', description: 'run a command', parameters: { type: 'object' } }],
    });
    expect(out.tools).toEqual([
      { type: 'function', function: { name: 'shell', description: 'run a command', parameters: { type: 'object' } } },
    ]);
  });

  test('maps tool_choice {type:"function",name} to the chat.completions shape', () => {
    const out = responsesToChat({ model: 'x', input: 'hi', tool_choice: { type: 'function', name: 'shell' } });
    expect(out.tool_choice).toEqual({ type: 'function', function: { name: 'shell' } });
  });

  test('passes through a string tool_choice verbatim', () => {
    const out = responsesToChat({ model: 'x', input: 'hi', tool_choice: 'required' });
    expect(out.tool_choice).toBe('required');
  });

  test('maps max_output_tokens to max_tokens and forwards stream', () => {
    const out = responsesToChat({ model: 'x', input: 'hi', max_output_tokens: 512, stream: true });
    expect(out.max_tokens).toBe(512);
    expect(out.stream).toBe(true);
  });

  test('client_metadata falls back to metadata when metadata is absent', () => {
    const out = responsesToChat({ model: 'x', input: 'hi', client_metadata: { session: 's1' } });
    expect(out.metadata).toEqual({ session: 's1' });
  });
});

describe('chatJsonToResponsesObject', () => {
  test('maps a plain-text chat.completion to a completed Responses object with an output_text item', () => {
    const out = chatJsonToResponsesObject({
      id: 'chatcmpl-1',
      model: 'codex/gpt-6-sol',
      choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    });
    expect(out.status).toBe('completed');
    expect(out.output_text).toBe('pong');
    expect(out.output).toEqual([
      {
        type: 'message',
        id: expect.stringMatching(/^msg_/),
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'pong', annotations: [] }],
      },
    ]);
    expect(out.usage).toEqual({ input_tokens: 10, output_tokens: 2, total_tokens: 12 });
  });

  test('maps tool_calls to function_call output items', () => {
    const out = chatJsonToResponsesObject({
      id: 'chatcmpl-2',
      model: 'codex/gpt-6-sol',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'shell', arguments: '{"cmd":"ls"}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
    expect(out.output).toEqual([
      {
        type: 'function_call',
        id: expect.stringMatching(/^fc_/),
        call_id: 'call_1',
        name: 'shell',
        arguments: '{"cmd":"ls"}',
        status: 'completed',
      },
    ]);
  });

  test('maps finish_reason "length" to status "incomplete"', () => {
    const out = chatJsonToResponsesObject({
      id: 'chatcmpl-3',
      model: 'x',
      choices: [{ index: 0, message: { role: 'assistant', content: 'cut off' }, finish_reason: 'length' }],
    });
    expect(out.status).toBe('incomplete');
  });
});

function sseStreamFromChunks(chunks: Record<string, unknown>[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

async function collectSseEvents(stream: ReadableStream<Uint8Array>): Promise<{ event: string; data: unknown }[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events: { event: string; data: unknown }[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
  }
  for (const block of buffer.split('\n\n')) {
    if (!block.trim()) continue;
    const eventLine = block.split('\n').find((l) => l.startsWith('event:'));
    const dataLine = block.split('\n').find((l) => l.startsWith('data:'));
    if (!eventLine || !dataLine) continue;
    events.push({ event: eventLine.slice(6).trim(), data: JSON.parse(dataLine.slice(5).trim()) });
  }
  return events;
}

describe('chatSseToResponsesSse', () => {
  test('streams text deltas as response.created -> response.output_text.delta -> response.completed', async () => {
    const upstream = sseStreamFromChunks([
      { id: 'chatcmpl-1', model: 'codex/gpt-6-sol', choices: [{ index: 0, delta: { content: 'pon' }, finish_reason: null }] },
      { id: 'chatcmpl-1', model: 'codex/gpt-6-sol', choices: [{ index: 0, delta: { content: 'g' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } },
    ]);
    const events = await collectSseEvents(chatSseToResponsesSse(upstream, { model: 'codex/gpt-6-sol' }));
    const types = events.map((e) => e.event);
    expect(types[0]).toBe('response.created');
    expect(types).toContain('response.output_text.delta');
    expect(types[types.length - 1]).toBe('response.completed');

    const deltas = events.filter((e) => e.event === 'response.output_text.delta').map((e) => (e.data as { delta: string }).delta);
    expect(deltas.join('')).toBe('pong');

    const completed = events.find((e) => e.event === 'response.completed')!.data as { response: { status: string; usage: unknown } };
    expect(completed.response.status).toBe('completed');
    expect(completed.response.usage).toEqual({ input_tokens: 5, output_tokens: 1, total_tokens: 6 });
  });

  test('streams a tool call as output_item.added -> function_call_arguments.delta -> output_item.done', async () => {
    const upstream = sseStreamFromChunks([
      {
        id: 'chatcmpl-2',
        model: 'codex/gpt-6-sol',
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'shell', arguments: '' } }] },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl-2',
        model: 'codex/gpt-6-sol',
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"cmd":"ls"}' } }] }, finish_reason: 'tool_calls' },
        ],
      },
    ]);
    const events = await collectSseEvents(chatSseToResponsesSse(upstream, { model: 'codex/gpt-6-sol' }));
    const types = events.map((e) => e.event);
    expect(types).toContain('response.output_item.added');
    expect(types).toContain('response.function_call_arguments.delta');
    expect(types).toContain('response.function_call_arguments.done');

    const done = events.find((e) => e.event === 'response.function_call_arguments.done')!.data as { arguments: string };
    expect(done.arguments).toBe('{"cmd":"ls"}');

    const completed = events.find((e) => e.event === 'response.completed')!.data as {
      response: { output: { type: string; id: string; name: string; call_id: string; arguments: string; status: string }[] };
    };
    expect(completed.response.output).toEqual([
      { type: 'function_call', id: expect.stringMatching(/^fc_/), call_id: 'call_1', name: 'shell', arguments: '{"cmd":"ls"}', status: 'completed' },
    ]);
  });

  test('an upstream break before [DONE] emits a Responses "error" event instead of a fake completion', async () => {
    const encoder = new TextEncoder();
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"id":"c1","model":"x","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n'));
        controller.error(new Error('boom'));
      },
    });
    const events = await collectSseEvents(chatSseToResponsesSse(upstream));
    expect(events.map((e) => e.event)).toContain('error');
  });
});
