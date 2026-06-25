import { describe, expect, test } from 'bun:test';
import type { UpstreamDescriptor } from '../../domain';
import { buildBedrockConverseRequest } from './request';
import { translateBedrockConverseResponse } from './response';

const descriptor: UpstreamDescriptor = {
  provider: 'bedrock',
  kind: 'bedrock-converse',
  baseUrl: 'https://bedrock-runtime.us-west-2.amazonaws.com',
  apiKey: 'bedrock-key',
  billingMode: 'credits',
  markup: 1,
  resolvedModel: 'deepseek.v3.2',
};

describe('buildBedrockConverseRequest', () => {
  test('translates messages, system, tools, and tool results to Converse shape', () => {
    const req = buildBedrockConverseRequest(
      {
        stream: true,
        max_tokens: 100,
        temperature: 0.5,
        messages: [
          { role: 'system', content: 'be terse' },
          { role: 'user', content: 'weather in Paris?' },
          { role: 'assistant', content: '', tool_calls: [{ id: 't1', function: { name: 'wx', arguments: '{"city":"Paris"}' } }] },
          { role: 'tool', tool_call_id: 't1', content: 'sunny' },
        ],
        tools: [{ function: { name: 'wx', description: 'weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
        tool_choice: 'required',
      },
      descriptor,
    );

    expect(req.url).toBe('https://bedrock-runtime.us-west-2.amazonaws.com/model/deepseek.v3.2/converse-stream');
    expect(req.headers.authorization).toBe('Bearer bedrock-key');
    const p = req.payload as any;
    expect(p.system).toEqual([{ text: 'be terse' }]);
    expect(p.inferenceConfig).toMatchObject({ maxTokens: 100, temperature: 0.5 });
    // assistant tool_call → toolUse with parsed input
    expect(p.messages[1]).toEqual({ role: 'assistant', content: [{ toolUse: { toolUseId: 't1', name: 'wx', input: { city: 'Paris' } } }] });
    // tool result → user message with toolResult
    expect(p.messages[2]).toEqual({ role: 'user', content: [{ toolResult: { toolUseId: 't1', content: [{ text: 'sunny' }] } }] });
    // tools → toolConfig.toolSpec; required → {any:{}}
    expect(p.toolConfig.tools[0].toolSpec).toMatchObject({ name: 'wx', inputSchema: { json: { type: 'object' } } });
    expect(p.toolConfig.toolChoice).toEqual({ any: {} });
  });

  test('non-streaming uses the converse action', () => {
    const req = buildBedrockConverseRequest({ messages: [{ role: 'user', content: 'hi' }] }, descriptor);
    expect(req.url).toEndWith('/converse');
  });
});

describe('buildBedrockConverseRequest — prompt caching (gated)', () => {
  const body = {
    messages: [
      { role: 'system', content: 'stable preamble' },
      { role: 'user', content: 'question' },
    ],
    tools: [{ function: { name: 'wx', parameters: { type: 'object' } } }],
  };

  test('inserts cachePoint blocks for a cache-supporting family', () => {
    const p = buildBedrockConverseRequest(body, { ...descriptor, resolvedModel: 'anthropic.claude-sonnet-4' }).payload as any;
    expect(p.system.at(-1)).toEqual({ cachePoint: { type: 'default' } });
    expect(p.toolConfig.tools.at(-1)).toEqual({ cachePoint: { type: 'default' } });
    expect(p.messages.at(-1).content.at(-1)).toEqual({ cachePoint: { type: 'default' } });
  });

  test('does NOT insert cachePoint for a model that rejects it', () => {
    const p = buildBedrockConverseRequest(body, { ...descriptor, resolvedModel: 'deepseek.v3.2' }).payload as any;
    expect(p.system).toEqual([{ text: 'stable preamble' }]);
    expect(JSON.stringify(p)).not.toContain('cachePoint');
  });
});

const enc = new TextEncoder();

// One AWS event-stream string header: 1B name-len · name · 1B type(7) · 2B val-len · val.
function header(name: string, value: string): Uint8Array {
  const n = enc.encode(name);
  const v = enc.encode(value);
  const out = new Uint8Array(1 + n.length + 1 + 2 + v.length);
  let p = 0;
  out[p++] = n.length;
  out.set(n, p);
  p += n.length;
  out[p++] = 7; // string type
  out[p++] = (v.length >> 8) & 0xff;
  out[p++] = v.length & 0xff;
  out.set(v, p);
  return out;
}

function concatAll(parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// A realistic AWS event-stream frame: 4B total · 4B headersLen · 4B preludeCRC ·
// headers · payload · 4B msgCRC. CRCs are unchecked by the parser → zero them.
// Emits THREE headers in the real Bedrock order (`:event-type` is NOT first) so
// the header-skipping logic actually runs.
function frame(eventType: string, payload: unknown, messageType = 'event'): Uint8Array {
  const headers = concatAll([
    header(':message-type', messageType),
    header(':event-type', eventType),
    header(':content-type', 'application/json'),
  ]);
  const body = enc.encode(JSON.stringify(payload));
  const total = 16 + headers.length + body.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, total);
  dv.setUint32(4, headers.length);
  out.set(headers, 12);
  out.set(body, 12 + headers.length);
  return out;
}

function eventStreamResponse(frames: Uint8Array[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const f of frames) c.enqueue(f);
      c.close();
    },
  });
  return new Response(body, { status: 200 });
}

// Deliver the whole byte stream re-chunked at a fixed size, so frames are split
// across reads and several can land in one read — exercises the buffering logic.
function rechunkedResponse(frames: Uint8Array[], chunkSize: number): Response {
  const all = concatAll(frames);
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < all.length; i += chunkSize) c.enqueue(all.subarray(i, i + chunkSize));
      c.close();
    },
  });
  return new Response(body, { status: 200 });
}

async function drain(rs: ReadableStream<Uint8Array>): Promise<string> {
  const reader = rs.getReader();
  const dec = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) out += dec.decode(value, { stream: true });
  }
  return out;
}

function parseChunks(text: string): any[] {
  return text
    .split('\n\n')
    .filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'))
    .map((l) => JSON.parse(l.slice(6)));
}

// text "Hello world" + one tool call wx({"city":"Paris"}), tool_use stop, usage.
const SAMPLE_FRAMES = [
  frame('messageStart', { role: 'assistant' }),
  frame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'Hello' } }),
  frame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: ' world' } }),
  frame('contentBlockStart', { contentBlockIndex: 1, start: { toolUse: { toolUseId: 't1', name: 'wx' } } }),
  frame('contentBlockDelta', { contentBlockIndex: 1, delta: { toolUse: { input: '{"city":' } } }),
  frame('contentBlockDelta', { contentBlockIndex: 1, delta: { toolUse: { input: '"Paris"}' } } }),
  frame('messageStop', { stopReason: 'tool_use' }),
  frame('metadata', { usage: { inputTokens: 10, outputTokens: 5 } }),
];

function assertSample(text: string) {
  const chunks = parseChunks(text);
  expect(chunks.map((c) => c.choices[0].delta.content).filter(Boolean).join('')).toBe('Hello world');
  const calls = chunks.flatMap((c) => c.choices[0].delta.tool_calls ?? []);
  expect(calls.map((t: any) => t.function?.name).filter(Boolean)[0]).toBe('wx');
  expect(calls.map((t: any) => t.function?.arguments ?? '').join('')).toBe('{"city":"Paris"}');
  const final = chunks.find((c) => c.choices[0].finish_reason);
  expect(final.choices[0].finish_reason).toBe('tool_calls');
  expect(final.usage).toMatchObject({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
}

describe('translateBedrockConverseResponse (streaming)', () => {
  test('converts a text + tool-call Converse stream to OpenAI SSE (multi-header frames)', async () => {
    const out = await translateBedrockConverseResponse(eventStreamResponse(SAMPLE_FRAMES), { streaming: true });
    assertSample(await drain(out.body!));
  });

  // The riskiest path: the network splits frames across reads and packs several
  // into one read. Re-chunk the exact same bytes at hostile sizes and the parser
  // must produce identical output.
  test.each([1, 2, 3, 7, 13, 64, 4096])('reassembles frames re-chunked at %i bytes', async (size) => {
    const out = await translateBedrockConverseResponse(rechunkedResponse(SAMPLE_FRAMES, size), { streaming: true });
    assertSample(await drain(out.body!));
  });

  test('emits distinct indices for two tool calls', async () => {
    const out = await translateBedrockConverseResponse(
      eventStreamResponse([
        frame('messageStart', { role: 'assistant' }),
        frame('contentBlockStart', { contentBlockIndex: 0, start: { toolUse: { toolUseId: 'a', name: 'one' } } }),
        frame('contentBlockDelta', { contentBlockIndex: 0, delta: { toolUse: { input: '{}' } } }),
        frame('contentBlockStart', { contentBlockIndex: 1, start: { toolUse: { toolUseId: 'b', name: 'two' } } }),
        frame('contentBlockDelta', { contentBlockIndex: 1, delta: { toolUse: { input: '{}' } } }),
        frame('messageStop', { stopReason: 'tool_use' }),
        frame('metadata', { usage: { inputTokens: 1, outputTokens: 1 } }),
      ]),
      { streaming: true },
    );
    const calls = parseChunks(await drain(out.body!)).flatMap((c) => c.choices[0].delta.tool_calls ?? []);
    const starts = calls.filter((t: any) => t.id);
    expect(starts.map((t: any) => [t.index, t.id, t.function.name])).toEqual([
      [0, 'a', 'one'],
      [1, 'b', 'two'],
    ]);
  });

  test('does not crash on an exception frame; still finalizes', async () => {
    const out = await translateBedrockConverseResponse(
      eventStreamResponse([
        frame('messageStart', { role: 'assistant' }),
        frame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'hi' } }),
        frame('modelStreamErrorException', { message: 'boom' }, 'exception'),
      ]),
      { streaming: true },
    );
    const text = await drain(out.body!);
    expect(parseChunks(text).map((c) => c.choices[0].delta.content).filter(Boolean).join('')).toBe('hi');
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });
});

describe('translateBedrockConverseResponse (non-streaming)', () => {
  test('translates a ConverseResponse to an OpenAI completion', async () => {
    const resp = new Response(
      JSON.stringify({
        output: { message: { role: 'assistant', content: [{ text: 'hi' }, { toolUse: { toolUseId: 't1', name: 'wx', input: { city: 'Paris' } } }] } },
        stopReason: 'tool_use',
        usage: { inputTokens: 7, outputTokens: 3 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
    const out = await translateBedrockConverseResponse(resp, { streaming: false });
    const body: any = await out.json();
    expect(body.choices[0].message.content).toBe('hi');
    expect(body.choices[0].message.tool_calls[0]).toMatchObject({ id: 't1', function: { name: 'wx', arguments: '{"city":"Paris"}' } });
    expect(body.choices[0].finish_reason).toBe('tool_calls');
    expect(body.usage).toMatchObject({ prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 });
  });

  test('surfaces an upstream error as an OpenAI error object', async () => {
    const resp = new Response(JSON.stringify({ message: 'throttled' }), { status: 429 });
    const out = await translateBedrockConverseResponse(resp, { streaming: false });
    expect(out.status).toBe(429);
    expect((await out.json()).error.message).toBe('throttled');
  });
});
