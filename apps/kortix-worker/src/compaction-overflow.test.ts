import { expect, test } from 'bun:test';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Usage,
} from '@earendil-works/pi-ai';
import type { AgentMessage, CompactionPreparation, Entry } from '@earendil-works/pi-agent-core';
import { summarizeContext } from './context-compaction';
import { recoverCompactionOverflow } from './compaction-overflow';

const user = (text: string): AgentMessage => ({
  role: 'user',
  content: [{ type: 'text', text }],
  timestamp: 1,
});
const entries = (messages: AgentMessage[]) =>
  messages.map((message, seq) => ({
    type: 'message',
    id: String(seq),
    parentId: seq ? String(seq - 1) : null,
    seq,
    timestamp: seq,
    message,
  })) as Entry[];
const overflow = () =>
  fauxAssistantMessage('', {
    stopReason: 'error',
    errorMessage: 'maximum context length is 4096 tokens',
  });

test('a rejected compaction retries bounded conversation segments and preserves file metadata', async () => {
  const provider = fauxProvider({ provider: 'overflow-test' });
  const models = createModels();
  models.setProvider(provider.provider);
  const model = { ...provider.getModel(), contextWindow: 4096 };
  const source = entries([
    user('START_COBALT ' + 'archive '.repeat(1600) + ' END_LIME'),
    fauxAssistantMessage(
      [fauxToolCall('read', { path: '/workspace/report.txt' }, { id: 'read-report' })],
      { stopReason: 'toolUse' },
    ),
    {
      role: 'toolResult',
      toolCallId: 'read-report',
      toolName: 'read',
      content: [{ type: 'text', text: 'read completed' }],
      isError: false,
      timestamp: 2,
    },
  ]);
  const original = structuredClone(source);
  const successfulUsage: Usage[] = [];
  const complete = models.completeSimple.bind(models);
  models.completeSimple = async (...args) => {
    const message = await complete(...args);
    if (message.stopReason !== 'error' && message.stopReason !== 'aborted') {
      const index = successfulUsage.length + 1;
      message.usage = {
        input: index * 10,
        output: 5,
        cacheRead: 3,
        cacheWrite: 2,
        totalTokens: index * 10 + 10,
        cost: { input: index, output: 2, cacheRead: 3, cacheWrite: 4, total: index + 9 },
      };
      successfulUsage.push(structuredClone(message.usage));
    }
    return message;
  };
  let recovered = 0;
  provider.setResponses([
    overflow(),
    ...Array.from({ length: 40 }, () => (context: any) => {
      const text = JSON.stringify(context.messages);
      expect(Buffer.byteLength(text)).toBeLessThan(10000);
      recovered++;
      return fauxAssistantMessage(
        ['START_COBALT', 'END_LIME'].filter((marker) => text.includes(marker)).join(' '),
      );
    }),
  ]);
  const result = await summarizeContext(source, models, model, new AbortController().signal);
  expect(result.summary).toContain('START_COBALT');
  expect(result.summary).toContain('END_LIME');
  expect(result.retainedTail).toEqual([]);
  expect(result.details).toEqual({ readFiles: ['/workspace/report.txt'], modifiedFiles: [] });
  expect(recovered).toBeGreaterThan(1);
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const) {
    expect(result.usage?.[key]).toBe(successfulUsage.reduce((sum, usage) => sum + usage[key], 0));
  }
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const) {
    expect(result.usage?.cost[key]).toBe(
      successfulUsage.reduce((sum, usage) => sum + usage.cost[key], 0),
    );
  }
  expect(source).toEqual(original);
});

test('a non-overflow compaction failure does not start segmented recovery', async () => {
  const provider = fauxProvider({ provider: 'denied-compaction' });
  const models = createModels();
  models.setProvider(provider.provider);
  provider.setResponses([
    fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'model access denied' }),
  ]);
  await expect(
    summarizeContext(
      entries([user('Remember cobalt')]),
      models,
      provider.getModel(),
      new AbortController().signal,
    ),
  ).rejects.toThrow('model access denied');
  expect(provider.state.callCount).toBe(1);
});

test('Stop during segmented recovery prevents the next segment and returns no partial summary', async () => {
  const provider = fauxProvider({ provider: 'stopped-compaction' });
  const models = createModels();
  models.setProvider(provider.provider);
  const controller = new AbortController();
  provider.setResponses([
    overflow(),
    () => {
      controller.abort(new Error('Stopped'));
      return fauxAssistantMessage('partial');
    },
  ]);
  await expect(
    summarizeContext(
      entries([user('archive '.repeat(3000))]),
      models,
      { ...provider.getModel(), contextWindow: 4096 },
      controller.signal,
    ),
  ).rejects.toThrow();
  expect(provider.state.callCount).toBe(2);
});

const preparation = (text: string): CompactionPreparation => ({
  messagesToSummarize: [user(text)],
  turnPrefixMessages: [],
  retainedTail: [],
  isSplitTurn: false,
  tokensBefore: text.length,
  fileOps: { read: new Set(), written: new Set(), edited: new Set() },
  settings: { enabled: true, reserveTokens: 512, keepRecentTokens: 0 },
});

test('recovery shrinks rejected segments without losing Unicode or the accumulated summary', async () => {
  const provider = fauxProvider({ provider: 'unicode-compaction' });
  const models = createModels();
  models.setProvider(provider.provider);
  const source = 'Start 🦜Ž中🚀 '.repeat(600) + 'END_COBALT';
  const segments: string[] = [];
  let rejected = 0;
  provider.setResponses(
    Array.from({ length: 80 }, () => (context, options) => {
      const prompt = context.messages[0]!;
      if (prompt.role !== 'user' || typeof prompt.content === 'string')
        throw new Error('Expected summary input');
      const block = prompt.content[0]!;
      if (block.type !== 'text') throw new Error('Expected summary text');
      const segment = block.text.match(
        /^<conversation>\n\[User\]: ([\s\S]*?)\n<\/conversation>/,
      )?.[1];
      if (!segment) throw new Error('Missing conversation segment');
      if (rejected === 0) {
        rejected++;
        return overflow();
      }
      expect(segment).not.toContain('�');
      if (segments.length) expect(block.text).toContain('ACCUMULATED_COBALT');
      expect(options?.maxTokens).toBeLessThanOrEqual(410);
      segments.push(segment);
      return fauxAssistantMessage('ACCUMULATED_COBALT');
    }),
  );
  const result = await recoverCompactionOverflow(
    preparation(source),
    models,
    { ...provider.getModel(), contextWindow: 4096 },
    new AbortController().signal,
  );
  expect(segments.join('')).toBe('[User]: ' + source);
  expect(Buffer.byteLength(segments[0]!)).toBeLessThan(2048);
  expect(result.summary).toContain('ACCUMULATED_COBALT');
  expect(rejected).toBe(1);
});

test('recovery rejects a transcript beyond its segment budget before calling the provider', async () => {
  const provider = fauxProvider({ provider: 'budget-compaction' });
  const models = createModels();
  models.setProvider(provider.provider);
  await expect(
    recoverCompactionOverflow(
      preparation('a'.repeat(2048 * 129)),
      models,
      { ...provider.getModel(), contextWindow: 4096 },
      new AbortController().signal,
    ),
  ).rejects.toThrow('128-segment');
  expect(provider.state.callCount).toBe(0);
});

test('repeated context rejection terminates instead of returning a partial summary', async () => {
  const provider = fauxProvider({ provider: 'retry-compaction' });
  const models = createModels();
  models.setProvider(provider.provider);
  provider.setResponses(Array.from({ length: 20 }, overflow));
  await expect(
    recoverCompactionOverflow(
      preparation('a'.repeat(5000)),
      models,
      { ...provider.getModel(), contextWindow: 4096 },
      new AbortController().signal,
    ),
  ).rejects.toThrow('maximum context length');
  expect(provider.state.callCount).toBe(3);
});

test('an adaptive split cannot expand a full recovery budget', async () => {
  const provider = fauxProvider({ provider: 'adaptive-budget-compaction' });
  const models = createModels();
  models.setProvider(provider.provider);
  provider.setResponses([overflow(), fauxAssistantMessage('must not succeed')]);
  await expect(
    recoverCompactionOverflow(
      preparation('a' + '🦜'.repeat((2048 * 127) / 4 - 5)),
      models,
      { ...provider.getModel(), contextWindow: 4096 },
      new AbortController().signal,
    ),
  ).rejects.toThrow('maximum context length');
  expect(provider.state.callCount).toBe(1);
});


test.each([false, true])('a truncated summary never replaces the conversation, overflow first=%s', async (overflowFirst) => {
  const provider = fauxProvider({ provider: 'truncated-compaction' });
  const models = createModels();
  models.setProvider(provider.provider);
  provider.setResponses([...(overflowFirst ? [overflow()] : []), fauxAssistantMessage('## Goal: read the', { stopReason: 'length' })]);
  const source = entries([user('The read already completed. Launch code cobalt.')]);
  await expect(summarizeContext(source, models, provider.getModel(), new AbortController().signal)).rejects.toThrow('output limit');
  expect(provider.state.callCount).toBe(overflowFirst ? 2 : 1);
});
