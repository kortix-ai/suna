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

describe('buildAnthropicRequest — tool_choice (SAFETY: none must not become auto)', () => {
  const withTools = (tool_choice: unknown) => ({
    messages: [{ role: 'user', content: 'go' }],
    tools: [
      { type: 'function', function: { name: 'search', description: 'd', parameters: { type: 'object' } } },
    ],
    tool_choice,
  });

  test("'none' maps to the explicit Anthropic {type:'none'} value, not omitted", () => {
    const req = buildAnthropicRequest(withTools('none'), descriptor);
    // Omitting tool_choice while `tools` is present defaults to Anthropic's own
    // 'auto' — so 'none' must be sent explicitly or Claude could call a
    // forbidden tool.
    expect(req.payload.tool_choice).toEqual({ type: 'none' });
  });

  test("'auto' omits tool_choice (Anthropic's own default when tools are present)", () => {
    const req = buildAnthropicRequest(withTools('auto'), descriptor);
    expect(req.payload.tool_choice).toBeUndefined();
  });

  test('omitted/null tool_choice also omits it from the payload', () => {
    const req = buildAnthropicRequest(withTools(undefined), descriptor);
    expect(req.payload.tool_choice).toBeUndefined();
    const req2 = buildAnthropicRequest(withTools(null), descriptor);
    expect(req2.payload.tool_choice).toBeUndefined();
  });

  test("'required' maps to {type:'any'}", () => {
    const req = buildAnthropicRequest(withTools('required'), descriptor);
    expect(req.payload.tool_choice).toEqual({ type: 'any' });
  });

  test('a named function tool_choice maps to {type:"tool", name}', () => {
    const req = buildAnthropicRequest(
      withTools({ type: 'function', function: { name: 'search' } }),
      descriptor,
    );
    expect(req.payload.tool_choice).toEqual({ type: 'tool', name: 'search' });
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

describe('buildAnthropicRequest — reasoning/thinking passthrough', () => {
  test('reasoning_effort maps to a thinking.budget_tokens block instead of being dropped', () => {
    const req = buildAnthropicRequest(
      { messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'high' },
      descriptor,
    );
    expect(req.payload.thinking).toEqual({ type: 'enabled', budget_tokens: 16000 });
  });

  test('an OpenAI-shaped reasoning object with an effort level translates too', () => {
    const req = buildAnthropicRequest(
      { messages: [{ role: 'user', content: 'hi' }], reasoning: { effort: 'medium' } },
      descriptor,
    );
    expect(req.payload.thinking).toEqual({ type: 'enabled', budget_tokens: 8192 });
  });

  test('an explicit budget_tokens on reasoning wins over the effort table', () => {
    const req = buildAnthropicRequest(
      { messages: [{ role: 'user', content: 'hi' }], reasoning: { budget_tokens: 5000 } },
      descriptor,
    );
    expect(req.payload.thinking).toEqual({ type: 'enabled', budget_tokens: 5000 });
  });

  test('a raw Anthropic-shaped thinking block passes through verbatim', () => {
    const req = buildAnthropicRequest(
      {
        messages: [{ role: 'user', content: 'hi' }],
        thinking: { type: 'enabled', budget_tokens: 10000 },
      },
      descriptor,
    );
    expect(req.payload.thinking).toEqual({ type: 'enabled', budget_tokens: 10000 });
  });

  test('no reasoning field at all omits thinking entirely (default behavior unchanged)', () => {
    const req = buildAnthropicRequest({ messages: [{ role: 'user', content: 'hi' }] }, descriptor);
    expect(req.payload.thinking).toBeUndefined();
  });

  test('bumps the default max_tokens ceiling so the thinking budget has room when the client set neither', () => {
    const req = buildAnthropicRequest(
      { messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'max' },
      descriptor,
    );
    expect(req.payload.max_tokens).toBeGreaterThan((req.payload.thinking as any).budget_tokens);
  });

  test('clamps budget_tokens below an explicit, smaller client max_tokens rather than 400ing upstream', () => {
    const req = buildAnthropicRequest(
      {
        messages: [{ role: 'user', content: 'hi' }],
        reasoning_effort: 'max',
        max_tokens: 2000,
      },
      descriptor,
    );
    expect(req.payload.max_tokens).toBe(2000);
    expect((req.payload.thinking as any).budget_tokens).toBeLessThan(2000);
  });

  test('drops temperature/top_p when thinking is enabled (Anthropic 400s on any non-default value)', () => {
    const req = buildAnthropicRequest(
      {
        messages: [{ role: 'user', content: 'hi' }],
        reasoning_effort: 'high',
        temperature: 0.7,
        top_p: 0.9,
      },
      descriptor,
    );
    expect(req.payload.thinking).toBeTruthy();
    expect(req.payload.temperature).toBeUndefined();
    expect(req.payload.top_p).toBeUndefined();
  });

  test('a raw Anthropic-shaped thinking block also suppresses temperature/top_p', () => {
    const req = buildAnthropicRequest(
      {
        messages: [{ role: 'user', content: 'hi' }],
        thinking: { type: 'enabled', budget_tokens: 4096 },
        temperature: 1,
        top_p: 0.5,
      },
      descriptor,
    );
    expect(req.payload.temperature).toBeUndefined();
    expect(req.payload.top_p).toBeUndefined();
  });

  test('temperature/top_p still forwarded normally when thinking is not requested', () => {
    const req = buildAnthropicRequest(
      { messages: [{ role: 'user', content: 'hi' }], temperature: 0.3, top_p: 0.8 },
      descriptor,
    );
    expect(req.payload.thinking).toBeUndefined();
    expect(req.payload.temperature).toBe(0.3);
    expect(req.payload.top_p).toBe(0.8);
  });
});

describe('buildAnthropicRequest — vision content-part translation', () => {
  test('translates a base64 data-URL image_url part into a native Anthropic image block', () => {
    const req = buildAnthropicRequest(
      {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'what is this?' },
              {
                type: 'image_url',
                image_url: { url: 'data:image/png;base64,AAAA' },
              },
            ],
          },
        ],
      },
      descriptor,
    );
    const messages = req.payload.messages as any[];
    const content = messages[0].content as any[];
    expect(content[0]).toEqual({ type: 'text', text: 'what is this?' });
    // Last content block also carries the prompt-cache breakpoint (existing
    // applyPromptCaching behavior) — assert the image translation itself,
    // not the cache_control tail-stamping.
    expect(content[1].type).toBe('image');
    expect(content[1].source).toEqual({ type: 'base64', media_type: 'image/png', data: 'AAAA' });
  });

  test('translates a remote-URL image_url part into a native Anthropic url-sourced image block', () => {
    const req = buildAnthropicRequest(
      {
        messages: [
          {
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: 'https://example.com/cat.png' } }],
          },
        ],
      },
      descriptor,
    );
    const messages = req.payload.messages as any[];
    const content = messages[0].content as any[];
    expect(content[0].type).toBe('image');
    expect(content[0].source).toEqual({ type: 'url', url: 'https://example.com/cat.png' });
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

  test('surfaces cache_creation_input_tokens (cache WRITE) and cache_read_input_tokens (cache READ) separately, not folded into a plain rate', async () => {
    const anthropic = new Response(
      JSON.stringify({
        id: 'msg_cache',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: 'hi' }],
        stop_reason: 'end_turn',
        // A real Anthropic prompt-cache usage payload: a fresh cache write plus
        // a read of a previously-cached block, alongside regular input.
        usage: {
          input_tokens: 50,
          cache_creation_input_tokens: 1200,
          cache_read_input_tokens: 300,
          output_tokens: 20,
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
    const out = await translateAnthropicResponse(anthropic, { streaming: false });
    const body = (await out.json()) as any;
    // Total input still folds everything in for total_tokens back-compat...
    expect(body.usage.prompt_tokens).toBe(50 + 1200 + 300);
    expect(body.usage.completion_tokens).toBe(20);
    expect(body.usage.total_tokens).toBe(50 + 1200 + 300 + 20);
    // ...but the cache read/write breakdown is surfaced separately so pricing
    // can apply the cache-write premium instead of the plain input rate.
    expect(body.usage.prompt_tokens_details).toEqual({
      cached_tokens: 300,
      cache_write_tokens: 1200,
    });
  });

  test('a response with no cache activity omits prompt_tokens_details entirely (unchanged shape)', async () => {
    const anthropic = new Response(
      JSON.stringify({
        id: 'msg_no_cache',
        model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: 'hi' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 2 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
    const out = await translateAnthropicResponse(anthropic, { streaming: false });
    const body = (await out.json()) as any;
    expect('prompt_tokens_details' in body.usage).toBe(false);
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

describe('translateAnthropicResponse (streaming)', () => {
  function anthropicSse(...frames: string[]): Response {
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(frames.join('')));
          controller.close();
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  }

  test('translates a mid-stream `error` event into an OpenAI-shaped error frame', async () => {
    const upstream = anthropicSse(
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-6","usage":{"input_tokens":10}}}\n\n',
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
    );
    const out = await translateAnthropicResponse(upstream, { streaming: true });
    const text = await new Response(out.body).text();

    // The error surfaces as a canonical `{error:{...}}` SSE frame that the probe /
    // sseErrorFrame recognize — not swallowed into a silent empty stop.
    expect(text).toContain('"error"');
    const frame = text
      .split('\n')
      .find((l) => l.startsWith('data:') && l.includes('"error"'))!
      .slice(5)
      .trim();
    const parsed = JSON.parse(frame) as { error: { message: string; type: string; code: string } };
    expect(parsed.error.message).toBe('Overloaded');
    expect(parsed.error.type).toBe('overloaded_error');
    expect(parsed.error.code).toBe('overloaded_error');
  });

  // Regression coverage for the "no guaranteed terminal frame" finding: Anthropic
  // never sends a `message_stop` after a mid-stream `error` event, so without an
  // explicit guarantee the translated stream ends with no [DONE] at all — a
  // client/proxy waiting on that terminator can hang.
  test('still terminates with data: [DONE] even though Anthropic sent no message_stop after the error', async () => {
    const upstream = anthropicSse(
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-6","usage":{"input_tokens":10}}}\n\n',
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
    );
    const out = await translateAnthropicResponse(upstream, { streaming: true });
    const text = await new Response(out.body).text();
    expect(text.trim().endsWith('data: [DONE]')).toBe(true);
  });

  // Regression coverage for the "mid-stream network failures laundered into a
  // clean success" finding: a raw read() exception (dropped connection, TLS
  // reset) previously hit a bare `catch { /* close what we have */ }` that
  // swallowed it with no trace and no terminal frame.
  test('a raw read() exception is surfaced as an error frame, not silently swallowed', async () => {
    const upstream = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_2","model":"claude-sonnet-4-6","usage":{"input_tokens":5}}}\n\n' +
                'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n',
            ),
          );
        },
        pull() {
          throw new Error('upstream socket reset');
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );

    const out = await translateAnthropicResponse(upstream, { streaming: true });
    const text = await new Response(out.body).text();

    expect(text).toContain('partial'); // whatever streamed before the break is preserved
    const frame = text
      .split('\n')
      .find((l) => l.startsWith('data:') && l.includes('"error"'))!
      .slice(5)
      .trim();
    const parsed = JSON.parse(frame) as { error: { message: string; code: string } };
    expect(parsed.error.message).toContain('upstream socket reset');
    expect(parsed.error.code).toBe('upstream_stream_error');
    expect(text.trim().endsWith('data: [DONE]')).toBe(true);
  });

  test('a streamed prompt-cache write is surfaced in the final usage chunk, not folded into a plain rate', async () => {
    const upstream = anthropicSse(
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-6","usage":{"input_tokens":50,"cache_creation_input_tokens":1200,"cache_read_input_tokens":300}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    );
    const out = await translateAnthropicResponse(upstream, { streaming: true });
    const text = await new Response(out.body).text();
    const usageFrame = text
      .split('\n\n')
      .map((f) => f.replace(/^data:\s*/, '').trim())
      .filter((f) => f && f !== '[DONE]')
      .map((f) => JSON.parse(f))
      .find((f) => f.usage);
    expect(usageFrame).toBeTruthy();
    expect(usageFrame.usage.prompt_tokens).toBe(50 + 1200 + 300);
    expect(usageFrame.usage.completion_tokens).toBe(5);
    expect(usageFrame.usage.prompt_tokens_details).toEqual({
      cached_tokens: 300,
      cache_write_tokens: 1200,
    });
  });
});
