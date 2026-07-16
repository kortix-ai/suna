import { describe, expect, test } from 'bun:test';

import { buildSidecarRequest, isSidecarEligible } from './sidecar';
import { buildUpstreamRequest } from './openai-compat';
import type { UpstreamDescriptor } from '../domain';

const descriptor: UpstreamDescriptor = {
  provider: 'openai',
  kind: 'openai-compat',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-real-upstream-key',
  billingMode: 'none',
  markup: 0,
  resolvedModel: 'gpt-5.6-sol',
};

describe('isSidecarEligible', () => {
  test('openai-compat and custom kinds are eligible', () => {
    expect(isSidecarEligible({ kind: 'openai-compat' })).toBe(true);
    expect(isSidecarEligible({ kind: 'custom' })).toBe(true);
  });

  test('anthropic, bedrock, and openai-responses are not eligible — they keep their dedicated transports', () => {
    expect(isSidecarEligible({ kind: 'anthropic' })).toBe(false);
    expect(isSidecarEligible({ kind: 'bedrock' })).toBe(false);
    expect(isSidecarEligible({ kind: 'openai-responses' })).toBe(false);
  });

  test('a descriptor with omitAuthorization (public upstream, no real key) is not eligible', () => {
    expect(isSidecarEligible({ kind: 'openai-compat', omitAuthorization: true })).toBe(false);
    expect(isSidecarEligible({ kind: 'custom', omitAuthorization: true })).toBe(false);
  });
});

describe('buildSidecarRequest', () => {
  test('targets the sidecar /v1/chat/completions, not the real upstream', () => {
    const direct = buildUpstreamRequest({ model: 'openai/gpt-5.6-sol', messages: [] }, descriptor);
    const req = buildSidecarRequest(direct, descriptor, { url: 'http://litellm:4000' });
    expect(req.url).toBe('http://litellm:4000/v1/chat/completions');
  });

  test('trims a trailing slash on the sidecar URL', () => {
    const direct = buildUpstreamRequest({ model: 'x', messages: [] }, descriptor);
    const req = buildSidecarRequest(direct, descriptor, { url: 'http://litellm:4000/' });
    expect(req.url).toBe('http://litellm:4000/v1/chat/completions');
  });

  test('carries the resolved upstream api_key/api_base per-request in the body', () => {
    const direct = buildUpstreamRequest({ model: 'x', messages: [] }, descriptor);
    const req = buildSidecarRequest(direct, descriptor, { url: 'http://litellm:4000' });
    expect(req.payload.api_key).toBe('sk-real-upstream-key');
    expect(req.payload.api_base).toBe('https://api.openai.com/v1');
  });

  test('authenticates to the sidecar with ITS OWN token, never the resolved upstream key', () => {
    const direct = buildUpstreamRequest({ model: 'x', messages: [] }, descriptor);
    const req = buildSidecarRequest(direct, descriptor, { url: 'http://litellm:4000', authToken: 'sk-sidecar-master' });
    expect(req.headers.authorization).toBe('Bearer sk-sidecar-master');
  });

  test('omits the Authorization header entirely when the sidecar has no master key configured', () => {
    const direct = buildUpstreamRequest({ model: 'x', messages: [] }, descriptor);
    const req = buildSidecarRequest(direct, descriptor, { url: 'http://litellm:4000' });
    expect(req.headers.authorization).toBeUndefined();
  });

  test('model passes through unchanged — no "openai/" provider-prefix wrapping (verified live: LiteLLM forwards a bare model string verbatim with the wildcard deployment)', () => {
    const direct = buildUpstreamRequest({ model: 'kortix/glm-5.2', messages: [] }, { ...descriptor, resolvedModel: 'z-ai/glm-5.2' });
    const req = buildSidecarRequest(direct, descriptor, { url: 'http://litellm:4000' });
    expect(req.payload.model).toBe('z-ai/glm-5.2');
  });

  test('preserves every other body field (messages, tools, stream, stream_options) untouched', () => {
    const body = {
      model: 'x',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'get_weather' } }],
      stream: true,
      stream_options: { include_usage: true },
    };
    const direct = buildUpstreamRequest(body, descriptor);
    const req = buildSidecarRequest(direct, descriptor, { url: 'http://litellm:4000' });
    expect(req.payload.messages).toEqual(body.messages);
    expect(req.payload.tools).toEqual(body.tools);
    expect(req.payload.stream).toBe(true);
    expect(req.payload.stream_options).toEqual({ include_usage: true });
  });

  // The genuine-OpenAI max_tokens -> max_completion_tokens rename (the hotfix
  // this migration replaces) still fires in direct mode's buildUpstreamRequest
  // before the sidecar rewrite ever sees the payload — but under sidecar mode
  // this rename should come from LiteLLM's own quirk tables instead, not ours
  // (that's the entire point of the migration). This just pins that the
  // sidecar rewrite itself passes max_tokens through untouched — it is NOT
  // where any quirk translation happens; the config-side flag decides which
  // one applies (see the call-upstream sidecar tests for the direct-vs-sidecar
  // request comparison).
  test('does not itself touch max_tokens — that is LiteLLM/the direct-transport concern, not this rewrite', () => {
    const direct = buildUpstreamRequest(
      { model: 'kortix/glm-5.2', messages: [], max_tokens: 4096 },
      { ...descriptor, provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', resolvedModel: 'openai/gpt-4o' },
    );
    const req = buildSidecarRequest(direct, { ...descriptor, provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' }, { url: 'http://litellm:4000' });
    expect(req.payload.max_tokens).toBe(4096);
    expect('max_completion_tokens' in req.payload).toBe(false);
  });
});
