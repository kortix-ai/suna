import { describe, expect, test } from 'bun:test';
import type { UpstreamDescriptor } from '../../domain';
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
    const req = buildBedrockRequest({ stream: true, messages: [{ role: 'user', content: 'hi' }] }, descriptor);
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
