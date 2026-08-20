import { describe, expect, it } from 'bun:test';
import type { UpstreamDescriptor } from '../../domain';
import { applyNativeGatewayShaping } from './request';

// Pure-function proof of the GATEWAY-SIDE, provider-specific request shaping the
// native `/language-model` path re-applies (see request.ts's
// applyNativeGatewayShaping doc). Each case mirrors exactly one tweak the
// OpenAI-compat path (buildAiSdkArgs + callUpstreamViaAiSdk) applies and the
// native passthrough would otherwise drop.

const CODEX: UpstreamDescriptor = {
  provider: 'openai-codex',
  kind: 'openai-responses',
  baseUrl: 'https://chatgpt.com/backend-api/codex',
  apiKey: 'sk-codex',
  resolvedModel: 'gpt-5.6-sol',
  billingMode: 'credits',
  markup: 1,
};

const OPENAI: UpstreamDescriptor = {
  provider: 'openai',
  kind: 'openai-compat',
  npm: '@ai-sdk/openai',
  baseUrl: 'https://api.openai.com',
  apiKey: 'sk-openai',
  resolvedModel: 'gpt-4o',
  billingMode: 'credits',
  markup: 1,
};

const OPENROUTER: UpstreamDescriptor = {
  provider: 'openrouter',
  kind: 'openai-compat',
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: 'sk-or',
  resolvedModel: 'anthropic/claude-x',
  billingMode: 'credits',
  markup: 1,
  bodyExtras: { provider: { order: ['Anthropic'], allow_fallbacks: false } },
};

const NOVA: UpstreamDescriptor = {
  provider: 'bedrock',
  kind: 'bedrock',
  npm: '@ai-sdk/amazon-bedrock',
  baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com',
  apiKey: 'sk-bedrock',
  resolvedModel: 'amazon.nova-pro-v1:0',
  region: 'us-east-1',
  billingMode: 'credits',
  markup: 1,
};

const ANTHROPIC: UpstreamDescriptor = {
  provider: 'anthropic',
  kind: 'anthropic',
  npm: '@ai-sdk/anthropic',
  baseUrl: 'https://api.anthropic.com',
  apiKey: 'sk-anthropic',
  resolvedModel: 'claude-fable-5',
  billingMode: 'credits',
  markup: 1,
};

describe('applyNativeGatewayShaping — codex', () => {
  it('sets providerOptions.openai.store = false and DROPS maxOutputTokens', () => {
    const out = applyNativeGatewayShaping(CODEX, { maxOutputTokens: 4096 });
    expect(out.providerOptions?.openai?.store).toBe(false);
    expect(out.maxOutputTokens).toBeUndefined();
  });

  it('preserves other client providerOptions while adding store', () => {
    const out = applyNativeGatewayShaping(CODEX, {
      providerOptions: { openai: { reasoningEffort: 'low' } },
      maxOutputTokens: 1000,
    });
    expect(out.providerOptions?.openai).toEqual({ reasoningEffort: 'low', store: false });
    expect(out.maxOutputTokens).toBeUndefined();
  });
});

describe('applyNativeGatewayShaping — plain openai (NOT codex)', () => {
  it('does NOT set store and forwards maxOutputTokens unchanged', () => {
    const out = applyNativeGatewayShaping(OPENAI, {
      providerOptions: { openai: { reasoningEffort: 'high' } },
      maxOutputTokens: 8192,
    });
    expect(out.providerOptions?.openai).toEqual({ reasoningEffort: 'high' });
    expect(out.providerOptions?.openai?.store).toBeUndefined();
    expect(out.maxOutputTokens).toBe(8192);
  });
});

describe('applyNativeGatewayShaping — openrouter bodyExtras', () => {
  it('merges descriptor.bodyExtras under the provider-name key', () => {
    const out = applyNativeGatewayShaping(OPENROUTER, { maxOutputTokens: 2048 });
    expect(out.providerOptions?.openrouter).toEqual({
      provider: { order: ['Anthropic'], allow_fallbacks: false },
    });
    // Non-codex → client cap forwarded.
    expect(out.maxOutputTokens).toBe(2048);
  });

  it('an upstream pin wins over a same-named client field (merged LAST)', () => {
    const out = applyNativeGatewayShaping(OPENROUTER, {
      providerOptions: { openrouter: { provider: { order: ['Client'] }, keep: true } },
    });
    expect(out.providerOptions?.openrouter).toEqual({
      keep: true,
      provider: { order: ['Anthropic'], allow_fallbacks: false },
    });
  });
});

describe('applyNativeGatewayShaping — bedrock Nova clamp', () => {
  it('clamps an over-large maxOutputTokens to the Nova ceiling (10000)', () => {
    const out = applyNativeGatewayShaping(NOVA, { maxOutputTokens: 128000 });
    expect(out.maxOutputTokens).toBe(10000);
  });

  it('leaves a smaller cap untouched', () => {
    const out = applyNativeGatewayShaping(NOVA, { maxOutputTokens: 4096 });
    expect(out.maxOutputTokens).toBe(4096);
  });
});

describe('applyNativeGatewayShaping — anthropic/bedrock-claude regression (no-op)', () => {
  it('forwards client providerOptions + maxOutputTokens verbatim, no store', () => {
    const out = applyNativeGatewayShaping(ANTHROPIC, {
      providerOptions: {
        anthropic: { thinking: { type: 'adaptive' }, effort: 'high' },
      },
      maxOutputTokens: 32000,
    });
    expect(out.providerOptions).toEqual({
      anthropic: { thinking: { type: 'adaptive' }, effort: 'high' },
    });
    expect(out.providerOptions?.openai).toBeUndefined();
    expect(out.maxOutputTokens).toBe(32000);
  });

  it('leaves providerOptions undefined when the client sent none', () => {
    const out = applyNativeGatewayShaping(ANTHROPIC, { maxOutputTokens: 4096 });
    expect(out.providerOptions).toBeUndefined();
    expect(out.maxOutputTokens).toBe(4096);
  });
});
