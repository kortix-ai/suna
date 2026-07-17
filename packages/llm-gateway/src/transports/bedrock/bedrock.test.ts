import { describe, expect, test } from 'bun:test';
import type { UpstreamDescriptor } from '../../domain';
import { type FetchImpl, callUpstream } from '../../http';
import { buildBedrockRequest } from './request';

const descriptor: UpstreamDescriptor = {
  provider: 'bedrock',
  kind: 'bedrock',
  baseUrl: 'https://bedrock-runtime.us-west-2.amazonaws.com',
  apiKey: 'bedrock-key',
  billingMode: 'credits',
  markup: 1,
  resolvedModel: 'us.anthropic.claude-sonnet-4-6',
};

describe('buildBedrockRequest', () => {
  test('targets the Anthropic InvokeModel endpoint with the bedrock anthropic_version', () => {
    const req = buildBedrockRequest({ messages: [{ role: 'user', content: 'hi' }] }, descriptor);
    expect(req.url).toBe(
      'https://bedrock-runtime.us-west-2.amazonaws.com/model/us.anthropic.claude-sonnet-4-6/invoke',
    );
    expect(req.headers.authorization).toBe('Bearer bedrock-key');
    expect((req.payload as any).anthropic_version).toBe('bedrock-2023-05-31');
  });

  test('uses the streaming action when stream is set', () => {
    const req = buildBedrockRequest(
      { stream: true, messages: [{ role: 'user', content: 'hi' }] },
      descriptor,
    );
    expect(req.url).toEndWith('/invoke-with-response-stream');
  });

  test('carries prompt-cache breakpoints through to the InvokeModel payload', () => {
    const req = buildBedrockRequest(
      {
        messages: [
          { role: 'system', content: 'stable preamble' },
          { role: 'user', content: 'question' },
        ],
        tools: [{ function: { name: 'wx', parameters: { type: 'object' } } }],
      },
      descriptor,
    );
    const p = req.payload as any;
    expect(p.system).toEqual([
      { type: 'text', text: 'stable preamble', cache_control: { type: 'ephemeral' } },
    ]);
    expect(p.tools.at(-1).cache_control).toEqual({ type: 'ephemeral' });
    expect(p.messages.at(-1).content.at(-1)).toEqual({
      type: 'text',
      text: 'question',
      cache_control: { type: 'ephemeral' },
    });
  });
});

describe('buildBedrockRequest — reasoning/thinking (inherits the anthropic core payload)', () => {
  test('reasoning_effort translates to a thinking.budget_tokens block, not silently dropped', () => {
    const req = buildBedrockRequest(
      { messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'high' },
      descriptor,
    );
    expect((req.payload as any).thinking).toEqual({ type: 'enabled', budget_tokens: 16000 });
  });

  test('drops temperature/top_p when thinking is enabled, same as the anthropic transport', () => {
    const req = buildBedrockRequest(
      {
        messages: [{ role: 'user', content: 'hi' }],
        reasoning_effort: 'high',
        temperature: 0.7,
        top_p: 0.9,
      },
      descriptor,
    );
    expect((req.payload as any).temperature).toBeUndefined();
    expect((req.payload as any).top_p).toBeUndefined();
  });
});

describe('buildBedrockRequest — tool_choice (SAFETY: inherits the anthropic core payload)', () => {
  const withTools = (tool_choice: unknown) => ({
    messages: [{ role: 'user', content: 'go' }],
    tools: [{ type: 'function', function: { name: 'search', parameters: { type: 'object' } } }],
    tool_choice,
  });

  test("'none' maps to the explicit {type:'none'} value, not omitted", () => {
    const req = buildBedrockRequest(withTools('none'), descriptor);
    expect((req.payload as any).tool_choice).toEqual({ type: 'none' });
  });

  test("'auto' omits tool_choice", () => {
    const req = buildBedrockRequest(withTools('auto'), descriptor);
    expect((req.payload as any).tool_choice).toBeUndefined();
  });

  test('omitted/null tool_choice omits it from the payload', () => {
    const req = buildBedrockRequest(withTools(undefined), descriptor);
    expect((req.payload as any).tool_choice).toBeUndefined();
    const req2 = buildBedrockRequest(withTools(null), descriptor);
    expect((req2.payload as any).tool_choice).toBeUndefined();
  });

  test("'required' maps to {type:'any'}", () => {
    const req = buildBedrockRequest(withTools('required'), descriptor);
    expect((req.payload as any).tool_choice).toEqual({ type: 'any' });
  });

  test('a named function tool_choice maps to {type:"tool", name}', () => {
    const req = buildBedrockRequest(
      withTools({ type: 'function', function: { name: 'search' } }),
      descriptor,
    );
    expect((req.payload as any).tool_choice).toEqual({ type: 'tool', name: 'search' });
  });
});

// End-to-end through the gateway's own dispatch path (callUpstream →
// transportFor('bedrock') → buildBedrockRequest → translateBedrockResponse),
// against a mock Bedrock runtime endpoint. Proves a BYOK-Bedrock descriptor
// (its own bearer key + regional endpoint, e.g. from resolveCandidates for a
// project that connected AWS_BEARER_TOKEN_BEDROCK) makes a well-formed
// InvokeModel call and gets a clean OpenAI chat.completion back — the whole
// standalone-provider round trip, no managed/credits path involved.
describe('BYOK Bedrock end-to-end via callUpstream', () => {
  const byok: UpstreamDescriptor = {
    provider: 'amazon-bedrock',
    kind: 'bedrock',
    baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com',
    apiKey: 'byok-bearer-token',
    billingMode: 'none',
    markup: 0,
    resolvedModel: 'us.anthropic.claude-opus-4-8',
  };

  test('signs with the project bearer key, targets /model/<id>/invoke, and returns a translated completion', async () => {
    let seenUrl = '';
    let seenHeaders: Record<string, string> = {};
    let seenBody: any = {};
    const fetchImpl: FetchImpl = async (url, init) => {
      seenUrl = url;
      seenHeaders = init.headers as Record<string, string>;
      seenBody = JSON.parse(String(init.body));
      // The InvokeModel (non-streaming) response body IS an Anthropic Messages JSON.
      return new Response(
        JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'Bedrock reply' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 11, output_tokens: 4 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const res = await callUpstream(
      {
        model: 'amazon-bedrock/us.anthropic.claude-opus-4-8',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      },
      byok,
      {
        fetchImpl,
        retry: { sleep: async () => {}, rand: () => 0.5, baseDelayMs: 1, maxAttempts: 3 },
      },
    );

    expect(seenUrl).toBe(
      'https://bedrock-runtime.us-east-1.amazonaws.com/model/us.anthropic.claude-opus-4-8/invoke',
    );
    expect(seenHeaders.authorization).toBe('Bearer byok-bearer-token');
    expect(seenBody.anthropic_version).toBe('bedrock-2023-05-31');
    // Anthropic core payload: role preserved, content normalized to blocks
    // (with prompt-cache control on the last turn — not asserted here).
    expect(seenBody.messages[0].role).toBe('user');
    expect(seenBody.messages[0].content[0]).toMatchObject({ type: 'text', text: 'hi' });

    const chat = (await res.json()) as any;
    expect(chat.choices[0].message.content).toBe('Bedrock reply');
    expect(chat.choices[0].finish_reason).toBe('stop');
    expect(chat.usage).toMatchObject({ prompt_tokens: 11, completion_tokens: 4 });
  });
});
