import { describe, expect, test } from 'bun:test';
import type { ModelPricingLookup, SessionLogMessage } from '@kortix/sdk';
import { NO_METRICS, sumMetrics, threadMetrics } from './session-context-sub-sessions';

const lookup: ModelPricingLookup = () => null;
const reply = (id: string, usage: NonNullable<SessionLogMessage['usage']>): SessionLogMessage =>
  ({ message_id: id, role: 'assistant', kind: 'turn', status: 'complete', in_context: true, usage, model: { provider: 'synthetic', model: 'synthetic' }, blocks: [] }) as unknown as SessionLogMessage;
const user = { message_id: 'user', role: 'user', kind: 'turn', status: 'complete', in_context: true, usage: null, blocks: [] } as unknown as SessionLogMessage;

describe('thread metrics', () => {
  test('counts every reply\'s tokens (cumulative, not just the last) and every message', () => {
    const metrics = threadMetrics(
      [
        reply('one', { input: 2, output: 3, reasoning: 4, cache_read: 5, cache_write: 6 }),
        reply('two', { input: 7, output: 8, reasoning: 9, cache_read: 10, cache_write: 11 }),
        user,
      ],
      lookup,
    );
    expect(metrics).toEqual({
      cost: 0, messages: 3,
      inputTokens: 9, outputTokens: 11, reasoningTokens: 13, cacheReadTokens: 15, cacheWriteTokens: 17,
    });
  });

  test('a reported cost is billed at the markup; an empty thread is zero', () => {
    const metrics = threadMetrics([reply('one', { input: 1, output: 1, cache_read: 0, cache_write: 0, cost: 0.5 })], lookup);
    expect(metrics.cost).toBeCloseTo(0.6, 9);
    expect(threadMetrics([], lookup)).toEqual(NO_METRICS);
  });

  test('sumMetrics adds every field', () => {
    const a = { ...NO_METRICS, cost: 1, messages: 2, inputTokens: 3 };
    const b = { ...NO_METRICS, cost: 0.5, messages: 1, outputTokens: 4 };
    expect(sumMetrics([a, b])).toEqual({ ...NO_METRICS, cost: 1.5, messages: 3, inputTokens: 3, outputTokens: 4 });
    expect(sumMetrics([])).toEqual(NO_METRICS);
  });
});
