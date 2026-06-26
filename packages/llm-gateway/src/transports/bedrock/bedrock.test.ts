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
