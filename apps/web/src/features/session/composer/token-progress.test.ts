import { describe, expect, test } from 'bun:test';

import type { MessageWithParts } from '@kortix/sdk/react';
import type { FlatModel } from '../model-flatten';
import { getContextLimit, getLastAssistantTokenTotal } from './token-progress';

function assistantMessage(tokens: Record<string, unknown> | undefined): MessageWithParts {
  return {
    info: { role: 'assistant', tokens } as any,
    parts: [],
  } as unknown as MessageWithParts;
}

function userMessage(): MessageWithParts {
  return { info: { role: 'user' } as any, parts: [] } as unknown as MessageWithParts;
}

function flatModel(overrides: Partial<FlatModel> = {}): FlatModel {
  return {
    providerID: 'anthropic',
    providerName: 'Anthropic',
    modelID: 'claude-5',
    modelName: 'Claude 5',
    ...overrides,
  };
}

describe('getLastAssistantTokenTotal', () => {
  test('returns 0 for undefined or empty message lists', () => {
    expect(getLastAssistantTokenTotal(undefined)).toBe(0);
    expect(getLastAssistantTokenTotal([])).toBe(0);
  });

  test('sums input/output/reasoning/cache tokens from the most recent assistant message', () => {
    const messages = [
      userMessage(),
      assistantMessage({ input: 100, output: 50, reasoning: 10, cache: { read: 5, write: 2 } }),
    ];
    expect(getLastAssistantTokenTotal(messages)).toBe(167);
  });

  test('skips trailing assistant messages with no token total and finds the last real one', () => {
    const messages = [
      assistantMessage({ input: 100, output: 50 }),
      userMessage(),
      assistantMessage(undefined),
    ];
    expect(getLastAssistantTokenTotal(messages)).toBe(150);
  });

  test('ignores user messages entirely, even if they carry a tokens-shaped field', () => {
    const messages = [assistantMessage({ input: 10, output: 10 }), userMessage()];
    expect(getLastAssistantTokenTotal(messages)).toBe(20);
  });
});

describe('getContextLimit', () => {
  test('falls back to 200k when no model is selected', () => {
    expect(getContextLimit(undefined, undefined)).toBe(200000);
    expect(getContextLimit([flatModel()], null)).toBe(200000);
  });

  test('uses the selected model contextWindow when present', () => {
    const models = [flatModel({ modelID: 'claude-5', contextWindow: 500000 })];
    expect(
      getContextLimit(models, { providerID: 'anthropic', modelID: 'claude-5' }),
    ).toBe(500000);
  });

  test('falls back to 200k when the selected model has no positive contextWindow', () => {
    const models = [flatModel({ modelID: 'claude-5', contextWindow: 0 })];
    expect(
      getContextLimit(models, { providerID: 'anthropic', modelID: 'claude-5' }),
    ).toBe(200000);
  });

  test('falls back to 200k when the selected model is not found in the list', () => {
    const models = [flatModel({ modelID: 'claude-5', contextWindow: 500000 })];
    expect(
      getContextLimit(models, { providerID: 'openai', modelID: 'gpt-5' }),
    ).toBe(200000);
  });
});
