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

  // P0 regression (req_mro97uigg6rnflvf): resolveCandidates built a descriptor
  // for `openai/gpt-5.6-sol` whose baseUrl WAS genuinely api.openai.com and the
  // request STILL 400ed with the max_tokens error in production — proving the
  // hostname-only gate was too fragile to trust as the ONLY signal. The
  // durable fix scopes on `descriptor.provider === 'openai'` (set once, from
  // the caller's requested id, in resolveCandidates.ts) so the rename fires no
  // matter which literal host that provider happens to resolve behind —
  // covering an operator-configured proxy, a managed/Azure-fronted route, or
  // any other non-`api.openai.com` OpenAI-compatible endpoint that still
  // speaks OpenAI's own chat/completions wire format.
  test('an OpenAI-labeled descriptor on a non-api.openai.com OpenAI-compatible host (managed/proxy/OpenRouter-fronted) still renames max_tokens', () => {
    const req = buildUpstreamRequest(
      { model: 'openai/gpt-5.6-sol', messages: [], max_tokens: 32000 },
      { ...openaiDescriptor, baseUrl: 'https://openrouter.ai/api/v1' },
    );
    expect(req.payload.max_completion_tokens).toBe(32000);
    expect('max_tokens' in req.payload).toBe(false);
  });

  test('a non-OpenAI model reached via the same non-genuine host is NOT translated (OpenRouter still wants max_tokens)', () => {
    const req = buildUpstreamRequest(
      { model: 'openrouter/anthropic/claude-x', messages: [], max_tokens: 4096 },
      { ...descriptor, provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', resolvedModel: 'anthropic/claude-x' },
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

describe('openai-compat: reasoning-restricted sampling params for genuine OpenAI', () => {
  const reasoningModelDescriptor: UpstreamDescriptor = {
    ...descriptor,
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    resolvedModel: 'gpt-5.6-sol',
    temperature: false,
  };

  test('strips temperature/top_p/penalties/logprobs for a genuine-OpenAI reasoning model', () => {
    const req = buildUpstreamRequest(
      {
        model: 'openai/gpt-5.6-sol',
        messages: [],
        temperature: 0.4,
        top_p: 0.9,
        presence_penalty: 0.2,
        frequency_penalty: 0.1,
        logprobs: true,
        top_logprobs: 3,
        logit_bias: { '123': 1 },
      },
      reasoningModelDescriptor,
    );
    for (const key of [
      'temperature',
      'top_p',
      'presence_penalty',
      'frequency_penalty',
      'logprobs',
      'top_logprobs',
      'logit_bias',
    ]) {
      expect(key in req.payload).toBe(false);
    }
  });

  test('leaves sampling params alone for a non-reasoning genuine-OpenAI model (capability flag true)', () => {
    const req = buildUpstreamRequest(
      { model: 'openai/gpt-4.1', messages: [], temperature: 0.4, top_p: 0.9 },
      { ...reasoningModelDescriptor, resolvedModel: 'gpt-4.1', temperature: true },
    );
    expect(req.payload.temperature).toBe(0.4);
    expect(req.payload.top_p).toBe(0.9);
  });

  test('leaves sampling params alone when the capability flag is unknown (undefined)', () => {
    const req = buildUpstreamRequest(
      { model: 'openai/some-model', messages: [], temperature: 0.4 },
      { ...reasoningModelDescriptor, temperature: undefined },
    );
    expect(req.payload.temperature).toBe(0.4);
  });

  test('does not strip sampling params for a reasoning-marked model on a DIFFERENT openai-compat host (OpenRouter)', () => {
    const req = buildUpstreamRequest(
      { model: 'kortix/o3', messages: [], temperature: 0.4, top_p: 0.9 },
      {
        ...descriptor,
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        temperature: false,
      },
    );
    expect(req.payload.temperature).toBe(0.4);
    expect(req.payload.top_p).toBe(0.9);
  });

  test('does not touch max_tokens translation behavior (both fixes compose cleanly)', () => {
    const req = buildUpstreamRequest(
      { model: 'openai/gpt-5.6-sol', messages: [], max_tokens: 4096, temperature: 0.7 },
      reasoningModelDescriptor,
    );
    expect(req.payload.max_completion_tokens).toBe(4096);
    expect('max_tokens' in req.payload).toBe(false);
    expect('temperature' in req.payload).toBe(false);
  });
});

describe('openai-compat: Perplexity role-sequence normalization', () => {
  const perplexityDescriptor: UpstreamDescriptor = {
    ...descriptor,
    provider: 'perplexity',
    baseUrl: 'https://api.perplexity.ai',
    resolvedModel: 'sonar-pro',
  };

  test('merges two consecutive user messages into one', () => {
    const req = buildUpstreamRequest(
      {
        model: 'perplexity/sonar-pro',
        messages: [
          { role: 'user', content: 'first' },
          { role: 'user', content: 'second' },
        ],
      },
      perplexityDescriptor,
    );
    const messages = req.payload.messages as any[];
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toBe('first\n\nsecond');
  });

  test('folds a `tool` result into the preceding user turn (no native tool role on Perplexity)', () => {
    const req = buildUpstreamRequest(
      {
        model: 'perplexity/sonar-pro',
        messages: [
          { role: 'user', content: 'question' },
          { role: 'tool', tool_call_id: 't1', content: 'tool result' },
        ],
      },
      perplexityDescriptor,
    );
    const messages = req.payload.messages as any[];
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toBe('question\n\ntool result');
  });

  test('a leading system message is preserved and never merged', () => {
    const req = buildUpstreamRequest(
      {
        model: 'perplexity/sonar-pro',
        messages: [
          { role: 'system', content: 'be helpful' },
          { role: 'user', content: 'first' },
          { role: 'user', content: 'second' },
        ],
      },
      perplexityDescriptor,
    );
    const messages = req.payload.messages as any[];
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: 'system', content: 'be helpful' });
    expect(messages[1].content).toBe('first\n\nsecond');
  });

  test('an already-alternating sequence passes through unchanged', () => {
    const req = buildUpstreamRequest(
      {
        model: 'perplexity/sonar-pro',
        messages: [
          { role: 'user', content: 'q1' },
          { role: 'assistant', content: 'a1' },
          { role: 'user', content: 'q2' },
        ],
      },
      perplexityDescriptor,
    );
    const messages = req.payload.messages as any[];
    expect(messages).toHaveLength(3);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });

  test('does not touch message sequencing for a non-Perplexity provider, even with same-role runs', () => {
    const req = buildUpstreamRequest(
      {
        model: 'kortix/glm-5.2',
        messages: [
          { role: 'user', content: 'first' },
          { role: 'user', content: 'second' },
        ],
      },
      { ...descriptor, provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' },
    );
    const messages = req.payload.messages as any[];
    expect(messages).toHaveLength(2);
  });

  test('merges consecutive assistant tool_calls arrays instead of dropping either', () => {
    const req = buildUpstreamRequest(
      {
        model: 'perplexity/sonar-pro',
        messages: [
          { role: 'assistant', content: '', tool_calls: [{ id: 'a', type: 'function', function: { name: 'x', arguments: '{}' } }] },
          { role: 'assistant', content: '', tool_calls: [{ id: 'b', type: 'function', function: { name: 'y', arguments: '{}' } }] },
        ],
      },
      perplexityDescriptor,
    );
    const messages = req.payload.messages as any[];
    expect(messages).toHaveLength(1);
    expect(messages[0].tool_calls).toHaveLength(2);
    expect(messages[0].tool_calls.map((t: any) => t.id)).toEqual(['a', 'b']);
  });
});

describe('openai-compat genuine-OpenAI stream_options.include_usage injection (BILLING-CORRECTNESS)', () => {
  const openaiDescriptor: UpstreamDescriptor = {
    ...descriptor,
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    resolvedModel: 'gpt-5.6-sol',
  };

  test('genuine OpenAI streaming request without stream_options gets include_usage force-injected', () => {
    const req = buildUpstreamRequest(
      { model: 'openai/gpt-5.6-sol', messages: [], stream: true },
      openaiDescriptor,
    );
    expect(req.payload.stream_options).toEqual({ include_usage: true });
  });

  test('genuine OpenAI streaming request that already set stream_options.include_usage is left untouched', () => {
    const req = buildUpstreamRequest(
      {
        model: 'openai/gpt-5.6-sol',
        messages: [],
        stream: true,
        stream_options: { include_usage: false },
      },
      openaiDescriptor,
    );
    expect(req.payload.stream_options).toEqual({ include_usage: false });
  });

  test('a non-streaming genuine OpenAI request is never given stream_options', () => {
    const req = buildUpstreamRequest(
      { model: 'openai/gpt-5.6-sol', messages: [] },
      openaiDescriptor,
    );
    expect('stream_options' in req.payload).toBe(false);
  });

  test('other openai-compat upstreams (OpenRouter, Groq, etc.) are untouched — they already emit usage without this flag', () => {
    const req = buildUpstreamRequest(
      { model: 'kortix/glm-5.2', messages: [], stream: true },
      { ...descriptor, provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' },
    );
    expect('stream_options' in req.payload).toBe(false);
  });

  test('preserves other keys already present on a caller-supplied stream_options object', () => {
    const req = buildUpstreamRequest(
      {
        model: 'openai/gpt-5.6-sol',
        messages: [],
        stream: true,
        stream_options: { some_other_flag: true },
      },
      openaiDescriptor,
    );
    expect(req.payload.stream_options).toEqual({ some_other_flag: true, include_usage: true });
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
