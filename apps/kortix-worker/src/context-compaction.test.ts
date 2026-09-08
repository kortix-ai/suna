import { expect, test } from 'bun:test';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { contextNeedsCompaction } from './context-compaction';

const model = fauxProvider({ provider: 'context-test' }).getModel();
const user = (text: string) => ({ role: 'user' as const, content: [{ type: 'text' as const, text }], timestamp: 1 });

test('does not compact an empty history or a short conversation', () => {
  expect(contextNeedsCompaction([], user('x'.repeat(500000)), model, '', [])).toBe(false);
  expect(contextNeedsCompaction([user('hello')], user('next'), model, '', [])).toBe(false);
});

test('includes the incoming prompt, system instructions, and tool definitions in its threshold', () => {
  const history = [user('old')];
  expect(contextNeedsCompaction(history, user('x'.repeat(450000)), model, '', [])).toBe(true);
  expect(contextNeedsCompaction(history, user('next'), model, 'x'.repeat(350000), [])).toBe(true);
  expect(contextNeedsCompaction(history, user('next'), model, '', [{ name: 'tool', description: 'x'.repeat(350000), parameters: {} }])).toBe(true);
});

test('uses provider usage and retains a conservative estimate when that usage is stale or smaller', () => {
  const assistant = fauxAssistantMessage('answer');
  assistant.usage = { ...assistant.usage, input: 120000, totalTokens: 120000 };
  expect(contextNeedsCompaction([user('old'), assistant], user('next'), model, '', [])).toBe(true);
  assistant.usage = { ...assistant.usage, input: 1, totalTokens: 1 };
  expect(contextNeedsCompaction([user('x'.repeat(450000)), assistant], user('next'), model, '', [])).toBe(true);
});

test('skips models that have no valid context limit', () => {
  for (const contextWindow of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(contextNeedsCompaction([user('old')], user('next'), { ...model, contextWindow }, '', [])).toBe(false);
  }
});
