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

// Build a single AWS event-stream frame: 4B total · 4B headersLen · 4B preludeCRC
// · headers · payload · 4B msgCRC. CRCs are unchecked by the parser, so zero them.
function frame(eventType: string, payload: unknown): Uint8Array {
  const enc = new TextEncoder();
  const name = enc.encode(':event-type');
  const et = enc.encode(eventType);
  const headers = new Uint8Array(1 + name.length + 1 + 2 + et.length);
  let p = 0;
  headers[p++] = name.length;
  headers.set(name, p);
  p += name.length;
  headers[p++] = 7; // string
  headers[p++] = (et.length >> 8) & 0xff;
  headers[p++] = et.length & 0xff;
  headers.set(et, p);
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

describe('translateBedrockConverseResponse (streaming)', () => {
  test('converts a text + tool-call Converse stream to OpenAI SSE', async () => {
    const resp = eventStreamResponse([
      frame('messageStart', { role: 'assistant' }),
      frame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'Hello' } }),
      frame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: ' world' } }),
      frame('contentBlockStart', { contentBlockIndex: 1, start: { toolUse: { toolUseId: 't1', name: 'wx' } } }),
      frame('contentBlockDelta', { contentBlockIndex: 1, delta: { toolUse: { input: '{"city":' } } }),
      frame('contentBlockDelta', { contentBlockIndex: 1, delta: { toolUse: { input: '"Paris"}' } } }),
      frame('messageStop', { stopReason: 'tool_use' }),
      frame('metadata', { usage: { inputTokens: 10, outputTokens: 5 } }),
    ]);

    const out = await translateBedrockConverseResponse(resp, { streaming: true });
    const text = await drain(out.body!);

    const chunks = text
      .split('\n\n')
      .filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'))
      .map((l) => JSON.parse(l.slice(6)));

    // text deltas concatenate
    const content = chunks.map((c) => c.choices[0].delta.content).filter(Boolean).join('');
    expect(content).toBe('Hello world');
    // tool call: name + concatenated arguments
    const toolName = chunks.flatMap((c) => c.choices[0].delta.tool_calls ?? []).map((t: any) => t.function?.name).filter(Boolean)[0];
    expect(toolName).toBe('wx');
    const args = chunks.flatMap((c) => c.choices[0].delta.tool_calls ?? []).map((t: any) => t.function?.arguments ?? '').join('');
    expect(args).toBe('{"city":"Paris"}');
    // final chunk: finish_reason + usage
    const final = chunks.find((c) => c.choices[0].finish_reason);
    expect(final.choices[0].finish_reason).toBe('tool_calls');
    expect(final.usage).toMatchObject({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });
});
