import { describe, expect, mock, test } from 'bun:test';
import type { ManagedModel } from '@kortix/shared/llm-catalog';

mock.module('../config', () => ({
  config: {
    AWS_BEDROCK_API_KEY: 'bedrock-test-key',
    AWS_BEDROCK_REGION: 'us-west-2',
    OPENROUTER_API_KEY: 'openrouter-test-key',
    OPENROUTER_API_URL: 'https://openrouter.test/api/v1',
    KORTIX_URL: 'https://kortix.test',
  },
}));

const { managedCandidates } = await import('../llm-gateway/resolution/descriptors');

describe('managed LLM upstream descriptors', () => {
  test('keeps Bedrock Converse models on the Bedrock Converse transport', () => {
    const managed: ManagedModel = {
      id: 'kimi-k2',
      name: 'Kimi K2',
      upstreamModelId: 'moonshotai.kimi-k2.5',
      transport: 'bedrock-converse',
      pricingRef: 'moonshotai/kimi-k2',
      tier: 'balanced',
    };

    const [descriptor] = managedCandidates(managed);

    expect(descriptor.provider).toBe('bedrock');
    expect(descriptor.kind).toBe('bedrock-converse');
    expect(descriptor.baseUrl).toBe('https://bedrock-runtime.us-west-2.amazonaws.com');
    expect(descriptor.resolvedModel).toBe('moonshotai.kimi-k2.5');
  });

  test('maps OpenRouter managed models to the OpenAI-compatible transport kind', () => {
    const managed: ManagedModel = {
      id: 'glm-4.6',
      name: 'GLM 4.6',
      upstreamModelId: 'z-ai/glm-4.6',
      transport: 'openrouter',
      pricingRef: 'z-ai/glm-4.6',
      tier: 'fast',
    };

    const [descriptor] = managedCandidates(managed);

    expect(descriptor.provider).toBe('openrouter');
    expect(descriptor.kind).toBe('openai-compat');
    expect(descriptor.baseUrl).toBe('https://openrouter.test/api/v1');
    expect(descriptor.resolvedModel).toBe('z-ai/glm-4.6');
  });
});
