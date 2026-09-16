import { expect, test } from 'bun:test';
import { QuestionBroker, QuestionRejectedError, type QuestionEvent } from './question-broker.ts';
import { QuestionCheckpointStore } from './question-checkpoint.ts';
import type { SessionLogItem } from './session-store.ts';

const question = {
  header: 'Mode',
  question: 'Choose.',
  custom: false,
  options: [{ label: 'Blue', description: 'First.' }],
};
const tool = { messageID: 'msg_assistant', callID: 'msg_assistant-p0' };
function setup() {
  const items: SessionLogItem[] = [];
  const log = {
    read: async () => structuredClone(items),
    append: async (item: SessionLogItem) => {
      items.push(structuredClone(item));
    },
  };
  const store = new QuestionCheckpointStore(log);
  const events: QuestionEvent[] = [];
  const broker = () =>
    new QuestionBroker({
      sessionId: 'ses_one',
      createId: () => 'que_one',
      publish: (event) => events.push(event),
      persistence: {
        open: (request, callId) => store.open('msg_user', callId, request),
        resolve: (id, value) => store.resolve(id, value),
        release: (id) => store.release(id),
      },
    });
  return { items, log, store, events, broker };
}
async function pending(broker: QuestionBroker) {
  for (let n = 0; n < 100; n++) {
    if (broker.list().length) return broker.list()[0]!;
    await Bun.sleep(1);
  }
  throw new Error('question did not become pending');
}

test('commits a question before publishing it and an answer before acknowledging it', async () => {
  const { broker, log, events, store } = setup();
  const first = broker();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const append = log.append;
  log.append = async (item) => {
    await gate;
    await append(item);
  };
  const answer = first.ask([question], { tool, toolCallId: 'native_call' });
  expect(first.list()).toEqual([]);
  expect(events).toEqual([]);
  release();
  await pending(first);
  log.append = async () => {
    throw new Error('offline');
  };
  await expect(first.reply('que_one', [['Blue']])).rejects.toThrow('offline');
  expect(first.list()).toHaveLength(1);
  expect(events).toHaveLength(1);
  log.append = append;
  expect(await first.reply('que_one', [['Blue']])).toBe(true);
  await expect(answer).resolves.toEqual([['Blue']]);
  expect(await store.active('msg_user')).toBeNull();
});

test('restores the captured request ID and applies a saved answer without asking again', async () => {
  const { broker, store, events } = setup();
  await store.open('msg_user', 'native_call', {
    id: 'que_captured',
    sessionID: 'ses_one',
    tool,
    questions: [question],
  });
  const replacement = broker();
  const result = replacement.ask([question], { tool, toolCallId: 'native_call' });
  expect((await pending(replacement)).id).toBe('que_captured');
  await replacement.reply('que_captured', [['Blue']]);
  await result;
  expect(events.at(-1)).toMatchObject({
    type: 'question.replied',
    properties: { requestID: 'que_captured' },
  });
});

test.each(['answer', 'reject'] as const)(
  'replays a saved %s and releases the checkpoint before the tool proceeds',
  async (kind) => {
    const { broker, store, events } = setup();
    await store.open('msg_user', 'native_call', {
      id: 'que_one',
      sessionID: 'ses_one',
      tool,
      questions: [question],
    });
    await store.resolve(
      'que_one',
      kind === 'answer' ? { answers: [['Blue']] } : { rejected: true },
    );
    const result = broker().ask([question], { tool, toolCallId: 'native_call' });
    if (kind === 'answer') await expect(result).resolves.toEqual([['Blue']]);
    else await expect(result).rejects.toBeInstanceOf(QuestionRejectedError);
    expect(events).toEqual([]);
    expect(await store.active('msg_user')).toBeNull();
  },
);
