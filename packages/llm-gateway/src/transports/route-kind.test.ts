import { describe, expect, test } from 'bun:test';
import type { UpstreamDescriptor } from '../domain';
import { resolveTransportKind } from './route-kind';

const reasoningTool = {
  type: 'function',
  function: { name: 'get_weather', description: 'd', parameters: { type: 'object' } },
};

const genuineOpenAiReasoning: UpstreamDescriptor = {
  provider: 'openai',
  kind: 'openai-compat',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  billingMode: 'platform-fee',
  markup: 0.1,
  resolvedModel: 'gpt-5.5',
  reasoning: true,
  temperature: false,
};

describe('resolveTransportKind', () => {
  test('genuine OpenAI reasoning model + function tools + reasoning_effort -> openai-responses', () => {
    const kind = resolveTransportKind(
      { model: 'openai/gpt-5.5', messages: [], tools: [reasoningTool], reasoning_effort: 'medium' },
      genuineOpenAiReasoning,
    );
    expect(kind).toBe('openai-responses');
  });

  test('genuine OpenAI reasoning model + tools, no explicit reasoning_effort (implicit non-none default) -> openai-responses', () => {
    const kind = resolveTransportKind(
      { model: 'openai/gpt-5.6', messages: [], tools: [reasoningTool] },
      genuineOpenAiReasoning,
    );
    expect(kind).toBe('openai-responses');
  });

  test('genuine OpenAI reasoning model + tools + reasoning_effort: "none" -> stays openai-compat (OpenAI\'s own documented escape hatch)', () => {
    const kind = resolveTransportKind(
      { model: 'openai/gpt-5.5', messages: [], tools: [reasoningTool], reasoning_effort: 'none' },
      genuineOpenAiReasoning,
    );
    expect(kind).toBe('openai-compat');
  });

  test('nested reasoning.effort: "none" shape is honored the same as the flat field', () => {
    const kind = resolveTransportKind(
      {
        model: 'openai/gpt-5.5',
        messages: [],
        tools: [reasoningTool],
        reasoning: { effort: 'none' },
      },
      genuineOpenAiReasoning,
    );
    expect(kind).toBe('openai-compat');
  });

  test('genuine OpenAI reasoning model, no tools -> stays openai-compat (not the broken combination)', () => {
    const kind = resolveTransportKind(
      { model: 'openai/gpt-5.5', messages: [], reasoning_effort: 'medium' },
      genuineOpenAiReasoning,
    );
    expect(kind).toBe('openai-compat');
  });

  test('genuine OpenAI reasoning model, empty tools array -> stays openai-compat', () => {
    const kind = resolveTransportKind(
      { model: 'openai/gpt-5.5', messages: [], tools: [], reasoning_effort: 'medium' },
      genuineOpenAiReasoning,
    );
    expect(kind).toBe('openai-compat');
  });

  test('non-reasoning OpenAI model (capability flag false) + tools + reasoning_effort -> stays openai-compat (no regression)', () => {
    const kind = resolveTransportKind(
      { model: 'openai/gpt-4.1', messages: [], tools: [reasoningTool], reasoning_effort: 'medium' },
      { ...genuineOpenAiReasoning, resolvedModel: 'gpt-4.1', reasoning: false },
    );
    expect(kind).toBe('openai-compat');
  });

  test('reasoning flag unset (unknown capability) + tools -> stays openai-compat (never guess)', () => {
    const kind = resolveTransportKind(
      {
        model: 'openai/some-model',
        messages: [],
        tools: [reasoningTool],
        reasoning_effort: 'medium',
      },
      { ...genuineOpenAiReasoning, reasoning: undefined },
    );
    expect(kind).toBe('openai-compat');
  });

  test('reasoning model + tools on a DIFFERENT openai-compat host (OpenRouter) -> stays openai-compat', () => {
    const kind = resolveTransportKind(
      { model: 'kortix/o3', messages: [], tools: [reasoningTool], reasoning_effort: 'medium' },
      {
        ...genuineOpenAiReasoning,
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
      },
    );
    expect(kind).toBe('openai-compat');
  });

  test('already anthropic/bedrock/openai-responses descriptors are never touched', () => {
    expect(
      resolveTransportKind(
        { tools: [reasoningTool], reasoning_effort: 'medium' },
        { ...genuineOpenAiReasoning, kind: 'anthropic' },
      ),
    ).toBe('anthropic');
    expect(
      resolveTransportKind(
        { tools: [reasoningTool], reasoning_effort: 'medium' },
        { ...genuineOpenAiReasoning, kind: 'bedrock' },
      ),
    ).toBe('bedrock');
    expect(
      resolveTransportKind(
        { tools: [reasoningTool], reasoning_effort: 'medium' },
        { ...genuineOpenAiReasoning, kind: 'openai-responses', provider: 'openai-codex' },
      ),
    ).toBe('openai-responses');
  });
});
