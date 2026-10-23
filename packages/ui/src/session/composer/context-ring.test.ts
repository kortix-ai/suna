import { describe, expect, test } from 'bun:test';

import { sessionLogOfV1Rows, type SessionLogMessage } from '@kortix/sdk';

import { getContextUsage } from './context-ring';
import { getLastAssistantTokenBreakdown } from './token-progress';

// One assistant record, as `sessionLogOfV1Rows` reads a v1 row with these tokens.
let seq = 0;
function assistantWithTokens(input: number, cache?: { read: number; write: number }, output?: number): SessionLogMessage {
  seq++;
  const row = { info: { id: `msg_${seq}`, role: 'assistant', time: { created: seq }, tokens: { input, cache, output } }, parts: [] };
  return sessionLogOfV1Rows('s', 'ses_root', [row] as never).threads[0]!.messages[0]!;
}

const MODELS = [
  { providerID: 'p', modelID: 'm', modelName: 'Test Model', contextWindow: 200_000 },
] as unknown as Parameters<typeof getContextUsage>[1];
const SELECTED = { providerID: 'p', modelID: 'm' };
const reading = (messages: SessionLogMessage[] | undefined) => {
  const { percent, tone } = getContextUsage(messages, MODELS, SELECTED);
  return { percent, tone };
};

describe('context reading against the model window', () => {
  test('no messages → 0% on the resting (info) tone', () => {
    expect(reading(undefined)).toEqual({ percent: 0, tone: 'info' });
  });

  test('reads the last assistant total against the window', () => {
    expect(reading([assistantWithTokens(100_000)])).toEqual({ percent: 50, tone: 'info' });
  });

  test('warning band at 70%', () => {
    expect(reading([assistantWithTokens(140_000)])).toEqual({ percent: 70, tone: 'warning' });
  });

  test('danger band at 85%', () => {
    expect(reading([assistantWithTokens(170_000)])).toEqual({ percent: 85, tone: 'destructive' });
  });

  test('clamps past-limit usage to 100%', () => {
    expect(reading([assistantWithTokens(999_999)])).toEqual({ percent: 100, tone: 'destructive' });
  });
});

describe('getContextUsage', () => {
  test('carries the full snapshot behind the reading', () => {
    expect(getContextUsage([assistantWithTokens(100_000)], MODELS, SELECTED)).toEqual({
      percent: 50,
      tone: 'info',
      ratio: 0.5,
      limit: 200_000,
      modelName: 'Test Model',
      breakdown: { input: 100_000, output: 0, reasoning: 0, cache: 0, total: 100_000 },
    });
  });

  test('an unknown window is null, never invented: the usage reads 0%', () => {
    expect(getContextUsage([assistantWithTokens(100_000)])).toEqual({
      percent: 0,
      tone: 'info',
      ratio: 0,
      limit: null,
      modelName: null,
      breakdown: { input: 100_000, output: 0, reasoning: 0, cache: 0, total: 100_000 },
    });
  });
});

test('unknown model and streaming assistant retain the last cached snapshot', () => {
  const previous = assistantWithTokens(100_000, { read: 20_000, write: 10_000 }, 10_000);
  const streaming = assistantWithTokens(0);
  const usage = getContextUsage([previous, streaming], [], { providerID: 'missing', modelID: 'missing' });
  expect(usage.breakdown).toEqual({ input: 100_000, output: 10_000, reasoning: 0, cache: 30_000, total: 140_000 });
  expect(usage.modelName).toBeNull();
  expect(usage.limit).toBeNull();
});

test('ring reading and card breakdown agree for cached streaming usage', () => {
  const messages = [assistantWithTokens(100_000, { read: 20_000, write: 10_000 }, 10_000), assistantWithTokens(0)];
  expect(reading(messages)).toEqual({ percent: 70, tone: 'warning' });
  expect(getLastAssistantTokenBreakdown(messages)).toEqual({ input: 100_000, output: 10_000, reasoning: 0, cache: 30_000, total: 140_000 });
});
