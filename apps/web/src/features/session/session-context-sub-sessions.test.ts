import { describe, expect, test } from 'bun:test';
import type { AssistantMessage, Message, Session } from '@kortix/sdk';
import { computeSubSessionCost, sumTreeCosts } from './session-context-sub-sessions';

const assistant = (id: string, sessionID: string, input: number): AssistantMessage => ({
  id, sessionID, role: 'assistant', time: { created: 1 }, parentID: 'user',
  modelID: 'model', providerID: 'provider', mode: 'build', agent: 'build',
  path: { cwd: '/', root: '/' }, cost: 0,
  tokens: { input, output: 2, reasoning: 3, cache: { read: 4, write: 5 } },
});

describe('sub-session aggregation characterization', () => {
  test('sums all assistant tokens, walks direct children, and totals descendants', () => {
    const messages: Record<string, Message[]> = {
      root: [assistant('a', 'root', 10), assistant('b', 'root', 20)],
      child: [assistant('c', 'child', 30)],
      grandchild: [assistant('d', 'grandchild', 40)],
    };
    const sessions = [{ id: 'child', title: 'Child' }, { id: 'grandchild', title: 'Grandchild' }] as Session[];
    const map = new Map([['root', ['child']], ['child', ['grandchild']]]);
    const tree = computeSubSessionCost('root', 'Root', messages, {}, map, sessions, () => null);
    expect(tree.inputTokens).toBe(30);
    expect(tree.messages).toBe(2);
    expect(tree.children[0].title).toBe('Child');
    expect(tree.children[0].children[0].inputTokens).toBe(40);
    expect(sumTreeCosts(tree)).toEqual({ cost: 0, messages: 4, inputTokens: 100,
      outputTokens: 8, reasoningTokens: 12, cacheReadTokens: 16, cacheWriteTokens: 20 });
  });

  test('missing store entries yield empty zero-cost nodes and fallback child title', () => {
    const tree = computeSubSessionCost('root', 'Root', {}, {},
      new Map([['root', ['missing-child']]]), [], () => null);
    expect(tree.children[0].title).toBe('missing-chil');
    expect(sumTreeCosts(tree)).toEqual({ cost: 0, messages: 0, inputTokens: 0,
      outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });
});
