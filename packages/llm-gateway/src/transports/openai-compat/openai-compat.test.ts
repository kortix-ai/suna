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
