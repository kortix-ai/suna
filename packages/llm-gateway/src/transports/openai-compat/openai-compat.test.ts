import { describe, test, expect } from 'bun:test';
import { buildUpstreamRequest } from './index';
import type { UpstreamDescriptor } from '../../domain';

const descriptor: UpstreamDescriptor = {
  provider: 'xai',
  kind: 'openai-compat',
  baseUrl: 'https://api.x.ai/v1',
  apiKey: 'sk-test',
  billingMode: 'none',
  markup: 0,
  resolvedModel: 'grok-4.3',
};

describe('openai-compat transport', () => {
  test('sends the resolved (prefix-stripped) model id, not the catalog id', () => {
    const req = buildUpstreamRequest({ model: 'xai/grok-4.3', messages: [] }, descriptor);
    expect(req.payload.model).toBe('grok-4.3');
    expect(req.url).toBe('https://api.x.ai/v1/chat/completions');
    expect(req.headers.authorization).toBe('Bearer sk-test');
  });

  test('falls back to the body model when no resolvedModel', () => {
    const req = buildUpstreamRequest({ model: 'foo/bar', messages: [] }, { ...descriptor, resolvedModel: undefined });
    expect(req.payload.model).toBe('foo/bar');
  });

  test('can omit Authorization for public upstreams like OpenCode Zen', () => {
    const req = buildUpstreamRequest(
      { model: 'deepseek-v4-flash-free', messages: [] },
      {
        ...descriptor,
        provider: 'opencode-zen',
        baseUrl: 'https://opencode.ai/zen/v1',
        apiKey: '',
        omitAuthorization: true,
        resolvedModel: 'deepseek-v4-flash-free',
      },
    );
    expect(req.url).toBe('https://opencode.ai/zen/v1/chat/completions');
    expect(req.payload.model).toBe('deepseek-v4-flash-free');
    expect(req.headers.authorization).toBeUndefined();
  });
});

describe('openai-compat max_tokens -> max_completion_tokens translation', () => {
  const openaiDescriptor: UpstreamDescriptor = {
    ...descriptor,
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    resolvedModel: 'gpt-5.6-sol',
  };

  test('genuine OpenAI: renames max_tokens to max_completion_tokens', () => {
    const req = buildUpstreamRequest(
      { model: 'openai/gpt-5.6-sol', messages: [], max_tokens: 4096 },
      openaiDescriptor,
    );
    expect(req.payload.max_completion_tokens).toBe(4096);
    expect('max_tokens' in req.payload).toBe(false);
  });

  test('genuine OpenAI: leaves an explicit max_completion_tokens untouched and drops nothing', () => {
    const req = buildUpstreamRequest(
      { model: 'openai/gpt-5.6-sol', messages: [], max_completion_tokens: 2048 },
      openaiDescriptor,
    );
    expect(req.payload.max_completion_tokens).toBe(2048);
    expect('max_tokens' in req.payload).toBe(false);
  });

  test('genuine OpenAI: does not invent max_completion_tokens when neither field is sent', () => {
    const req = buildUpstreamRequest({ model: 'openai/gpt-5.6-sol', messages: [] }, openaiDescriptor);
    expect('max_completion_tokens' in req.payload).toBe(false);
    expect('max_tokens' in req.payload).toBe(false);
  });

  test('genuine OpenAI: if both are already present, the client value wins (no silent drop of data)', () => {
    const req = buildUpstreamRequest(
      { model: 'openai/gpt-5.6-sol', messages: [], max_tokens: 999, max_completion_tokens: 111 },
      openaiDescriptor,
    );
    expect(req.payload.max_completion_tokens).toBe(111);
    expect(req.payload.max_tokens).toBe(999);
  });

  test('OpenRouter (openai-compat, different host): keeps max_tokens as-is', () => {
    const req = buildUpstreamRequest(
      { model: 'kortix/glm-5.2', messages: [], max_tokens: 4096 },
      { ...descriptor, provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' },
    );
    expect(req.payload.max_tokens).toBe(4096);
    expect('max_completion_tokens' in req.payload).toBe(false);
  });

  test('other openai-compat upstreams (Groq, x.ai, self-hosted/custom) keep max_tokens as-is', () => {
    const req = buildUpstreamRequest({ model: 'xai/grok-4.3', messages: [], max_tokens: 512 }, descriptor);
    expect(req.payload.max_tokens).toBe(512);
    expect('max_completion_tokens' in req.payload).toBe(false);
  });

  test('a baseUrl that merely contains "api.openai.com" as a substring (not the real host) is not translated', () => {
    const req = buildUpstreamRequest(
      { model: 'evil/model', messages: [], max_tokens: 1 },
      { ...descriptor, provider: 'evil', baseUrl: 'https://not-api.openai.com.evil.example/v1' },
    );
    expect(req.payload.max_tokens).toBe(1);
    expect('max_completion_tokens' in req.payload).toBe(false);
  });
});

describe('openai-compat bodyExtras', () => {
  test('merges descriptor bodyExtras into the payload, overriding client fields', () => {
    const req = buildUpstreamRequest(
      { model: 'kortix/glm-5.2', messages: [], provider: { order: ['evil'] } },
      {
        ...descriptor,
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        resolvedModel: 'z-ai/glm-5.2',
        bodyExtras: { provider: { order: ['z-ai'], allow_fallbacks: true } },
      },
    );
    expect(req.payload.provider).toEqual({ order: ['z-ai'], allow_fallbacks: true });
    expect(req.payload.model).toBe('z-ai/glm-5.2');
  });

  test('bodyExtras cannot clobber the resolved model', () => {
    const req = buildUpstreamRequest(
      { model: 'kortix/glm-5.2', messages: [] },
      { ...descriptor, resolvedModel: 'z-ai/glm-5.2', bodyExtras: { model: 'other' } },
    );
    expect(req.payload.model).toBe('z-ai/glm-5.2');
  });

  test('payload untouched without bodyExtras', () => {
    const req = buildUpstreamRequest({ model: 'xai/grok-4.3', messages: [] }, descriptor);
    expect('provider' in req.payload).toBe(false);
  });
});
