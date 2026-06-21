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
});
