import { describe, expect, test } from 'bun:test';
import type { AssistantMessage, Message, ModelPricingLookup, Session } from '@kortix/sdk';
import { computeSubSessionCost, sumTreeCosts } from './session-context-sub-sessions';

const lookup: ModelPricingLookup = () => null;
const session = (id: string, title?: string) => ({ id, title }) as Session;
const assistant = (id: string, tokens: AssistantMessage['tokens']): AssistantMessage => ({
  id,
  role: 'assistant',
  sessionID: 'root',
  tokens,
  cost: 0,
  modelID: 'synthetic',
  providerID: 'synthetic',
  mode: 'build',
  agent: 'build',
  parentID: 'user',
  path: { cwd: '/tmp', root: '/tmp' },
  time: { created: 1 },
});

describe('sub-session cost aggregation', () => {
  test('counts assistant tokens across messages and walks direct children recursively', () => {
    const messages: Record<string, Message[]> = {
      root: [
        assistant('one', { input: 2, output: 3, reasoning: 4, cache: { read: 5, write: 6 } }),
        assistant('two', { input: 7, output: 8, reasoning: 9, cache: { read: 10, write: 11 } }),
        { id: 'user', role: 'user' } as Message,
      ],
      child: [assistant('three', { input: 13, output: 14, reasoning: 15, cache: { read: 16, write: 17 } })],
    };
    const tree = computeSubSessionCost('root', 'Root', messages, {}, new Map([
      ['root', ['child']],
      ['child', ['leaf']],
    ]), [session('child', 'Child')], lookup);
    expect(tree).toMatchObject({
      id: 'root', title: 'Root', messages: 3, cost: 0,
      inputTokens: 9, outputTokens: 11, reasoningTokens: 13,
      cacheReadTokens: 15, cacheWriteTokens: 17,
      children: [{ id: 'child', title: 'Child', messages: 1, inputTokens: 13,
        children: [{ id: 'leaf', title: 'leaf', messages: 0, cost: 0, children: [] }] }],
    });
    expect(sumTreeCosts(tree)).toEqual({
      cost: 0, messages: 4, inputTokens: 22, outputTokens: 25,
      reasoningTokens: 28, cacheReadTokens: 31, cacheWriteTokens: 34,
    });
  });

  test('missing store lookups and no children yield zero totals', () => {
    const tree = computeSubSessionCost('empty', 'Empty', {}, {}, new Map(), [], lookup);
    expect(tree.children).toEqual([]);
    expect(sumTreeCosts(tree)).toEqual({
      cost: 0, messages: 0, inputTokens: 0, outputTokens: 0,
      reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    });
  });
});
