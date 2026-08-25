import { describe, expect, test } from 'bun:test';

import type { MessageWithParts } from '@kortix/sdk/react';

import { getContextReading, getContextUsage } from './context-ring';

function assistantWithTokens(input: number): MessageWithParts {
  return {
    info: { id: 'msg_1', role: 'assistant', tokens: { input } },
    parts: [],
  } as unknown as MessageWithParts;
}

describe('getContextReading', () => {
  test('no messages → 0% on the resting (info) tone', () => {
    expect(getContextReading(undefined)).toEqual({ percent: 0, tone: 'info' });
  });

  test('reads the last assistant total against the default 200k window', () => {
    expect(getContextReading([assistantWithTokens(100_000)])).toEqual({
      percent: 50,
      tone: 'info',
    });
  });

  test('warning band at 70%', () => {
    expect(getContextReading([assistantWithTokens(140_000)])).toEqual({
      percent: 70,
      tone: 'warning',
    });
  });

  test('danger band at 85%', () => {
    expect(getContextReading([assistantWithTokens(170_000)])).toEqual({
      percent: 85,
      tone: 'destructive',
    });
  });

  test('clamps past-limit usage to 100%', () => {
    expect(getContextReading([assistantWithTokens(999_999)])).toEqual({
      percent: 100,
      tone: 'destructive',
    });
  });

  test("uses the selected model's own window when the catalog knows it", () => {
    const models = [
      { providerID: 'p', modelID: 'm', contextWindow: 100_000 },
    ] as unknown as Parameters<typeof getContextReading>[1];
    expect(
      getContextReading([assistantWithTokens(80_000)], models, { providerID: 'p', modelID: 'm' }),
    ).toEqual({ percent: 80, tone: 'warning' });
  });
});

describe('getContextUsage', () => {
  test('carries the full snapshot behind the reading', () => {
    expect(getContextUsage([assistantWithTokens(100_000)])).toEqual({
      percent: 50,
      tone: 'info',
      ratio: 0.5,
      limit: 200_000,
      modelName: null,
      breakdown: { input: 100_000, output: 0, reasoning: 0, cache: 0, total: 100_000 },
    });
  });

  test('empty session → zeroed breakdown on the resting tone', () => {
    expect(getContextUsage(undefined)).toEqual({
      percent: 0,
      tone: 'info',
      ratio: 0,
      limit: 200_000,
      modelName: null,
      breakdown: { input: 0, output: 0, reasoning: 0, cache: 0, total: 0 },
    });
  });

  test("resolves the selected model's name and window from the catalog", () => {
    const models = [
      { providerID: 'p', modelID: 'm', modelName: 'Test Model', contextWindow: 100_000 },
    ] as unknown as Parameters<typeof getContextUsage>[1];
    const usage = getContextUsage([assistantWithTokens(80_000)], models, {
      providerID: 'p',
      modelID: 'm',
    });
    expect(usage.limit).toBe(100_000);
    expect(usage.modelName).toBe('Test Model');
    expect(usage.percent).toBe(80);
    expect(usage.tone).toBe('warning');
  });

  test('the reading is the usage projected to percent + tone', () => {
    const messages = [assistantWithTokens(140_000)];
    const usage = getContextUsage(messages);
    expect(getContextReading(messages)).toEqual({ percent: usage.percent, tone: usage.tone });
  });
});
