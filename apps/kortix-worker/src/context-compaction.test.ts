import { expect, test } from 'bun:test';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import type { AgentMessage, Entry } from '@earendil-works/pi-agent-core';
import { compactedModelContext, contextNeedsCompaction, summarizeContext } from './context-compaction';

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

test('summarizes an oversized retained tool batch with its file metadata and no remaining tool payload', async () => {
  const provider = fauxProvider({ provider: 'retention-test' });
  const models = createModels();
  models.setProvider(provider.provider);
  const selected = { ...provider.getModel(), contextWindow: 4096 };
  const messages: AgentMessage[] = [
    user('Remember cobalt and write the report.'),
    fauxAssistantMessage([fauxToolCall('write', { path: '/workspace/report.txt', content: 'cobalt' }, { id: 'write-report' })], { stopReason: 'toolUse' }),
    { role: 'toolResult', toolCallId: 'write-report', toolName: 'write', content: [{ type: 'text', text: 'LARGE_RESULT: ' + 'data '.repeat(3000) }], isError: false, timestamp: 2 },
  ];
  const entries = messages.map((message, seq) => ({ type: 'message', id: String(seq), parentId: seq ? String(seq - 1) : null, seq, timestamp: seq, message })) as Entry[];
  provider.setResponses([ctx => {
    const text = JSON.stringify(ctx.messages);
    expect(text.includes('LARGE_RESULT')).toBe(true);
    expect(text.includes('cobalt')).toBe(true);
    return fauxAssistantMessage('The report contains cobalt.');
  }]);
  const result = await summarizeContext(entries, models, selected, new AbortController().signal);
  expect(result.retainedTail).toEqual([]);
  expect(result.summary).toContain('The report contains cobalt.');
  expect(result.details).toEqual({ readFiles: [], modifiedFiles: ['/workspace/report.txt'] });
  expect(provider.state.callCount).toBe(1);
});

test('retained assistant usage from before compaction cannot trigger another full-context estimate', () => {
  const assistant = fauxAssistantMessage([fauxToolCall('read', { path: '/workspace/report.txt' })], { stopReason: 'toolUse' });
  assistant.usage = { ...assistant.usage, input: 120000, totalTokens: 120000 };
  const shown = { ...fauxAssistantMessage('summary'), kortixWireMessageId: 'summary-message' };
  const entries = [{ type: 'compaction', seq: 1, timestamp: 1, summary: 'Remember cobalt.', tokensBefore: 120000,
    retainedTail: [assistant], details: { kortixDisplayMessages: [shown] } }] as unknown as Entry[];
  const context = compactedModelContext([shown], entries);
  expect(contextNeedsCompaction(context, user('Continue.'), model, '', [])).toBe(false);
  expect(assistant.usage.input).toBe(120000);
});
