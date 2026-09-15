import { expect, test } from 'bun:test';
import { QuestionCheckpointStore, QUESTION_CHECKPOINT_STREAM } from './question-checkpoint.ts';
import type { SessionLogItem } from './session-store.ts';

const request = {
  id: 'que_saved',
  sessionID: 'ses_one',
  questions: [
    {
      header: 'Mode',
      question: 'Choose a mode.',
      custom: false,
      options: [
        { label: 'Blue', description: 'First.' },
        { label: 'Green', description: 'Second.' },
      ],
    },
  ],
  tool: { messageID: 'msg_assistant', callID: 'msg_assistant-p0' },
};

test('a later assistant batch can reuse a native question call ID without reusing the old answer', async () => {
  const { store } = setup();
  await store.open('msg_user', 'native_call', request);
  await store.resolve(request.id, { answers: [['Blue']] });
  await store.release(request.id);
  const later = {
    ...request,
    id: 'que_later',
    tool: { messageID: 'msg_later', callID: 'msg_later-p0' },
  };
  expect(await store.open('msg_user', 'native_call', later)).toMatchObject({
    request: later,
    resolution: null,
  });
});
function setup(items: SessionLogItem[] = []) {
  const log = {
    read: async () => structuredClone(items),
    append: async (item: SessionLogItem) => {
      items.push(structuredClone(item));
    },
  };
  return { items, log, store: new QuestionCheckpointStore(log) };
}

test('restores a pending question, then its committed answer until execution is released', async () => {
  const { items, log, store } = setup();
  await store.open('msg_user', 'native_call', request);
  const replacement = new QuestionCheckpointStore(log);
  expect(await replacement.active('msg_user')).toMatchObject({
    request,
    toolCallId: 'native_call',
    resolution: null,
  });
  expect(
    await replacement.open('msg_user', 'native_call', { ...request, id: 'que_new' }),
  ).toMatchObject({ request });
  expect(items).toHaveLength(1);
  await replacement.resolve(request.id, { answers: [['Blue']] });
  expect(await new QuestionCheckpointStore(log).active('msg_user')).toMatchObject({
    resolution: { answers: [['Blue']] },
  });
  await replacement.release(request.id);
  expect(await new QuestionCheckpointStore(log).active('msg_user')).toBeNull();
  expect(items).toHaveLength(3);
});

test('does not expose a pending question or acknowledge an answer before append commits', async () => {
  const { items, log, store } = setup();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const append = log.append;
  log.append = async (item) => {
    await gate;
    await append(item);
  };
  const open = store.open('msg_user', 'native_call', request);
  await Bun.sleep(1);
  expect(await new QuestionCheckpointStore(log).active('msg_user')).toBeNull();
  release();
  await open;
  log.append = async () => {
    throw new Error('store unavailable');
  };
  await expect(store.resolve(request.id, { answers: [['Blue']] })).rejects.toThrow(
    'store unavailable',
  );
  expect(await store.active('msg_user')).toMatchObject({ resolution: null });
  expect(items).toHaveLength(1);
});

test('serializes competing answers and rejects a conflicting or invalid resolution', async () => {
  const { store, items } = setup();
  await store.open('msg_user', 'native_call', request);
  await expect(store.resolve(request.id, { answers: [['Unknown']] })).rejects.toThrow(/option/);
  await expect(store.resolve(request.id, { answers: [['Blue'], ['Green']] })).rejects.toThrow(
    /one answer/,
  );
  const outcomes = await Promise.allSettled([
    store.resolve(request.id, { answers: [['Blue']] }),
    store.resolve(request.id, { answers: [['Green']] }),
  ]);
  expect(outcomes.map((item) => item.status)).toEqual(['fulfilled', 'rejected']);
  await store.resolve(request.id, { answers: [['Blue']] });
  expect(items).toHaveLength(2);
});

test('rejects another question before the current checkpoint is released', async () => {
  const { store } = setup();
  await store.open('msg_user', 'native_call', request);
  await expect(
    store.open('msg_user', 'other_call', { ...request, id: 'que_other' }),
  ).rejects.toThrow(/active/);
  await expect(
    store.open('msg_user', 'native_call', {
      ...request,
      questions: [{ ...request.questions[0]!, question: 'Changed?' }],
    }),
  ).rejects.toThrow(/conflicting/);
  await store.resolve(request.id, { rejected: true });
  await store.release(request.id);
  expect(await store.open('msg_user', 'other_call', { ...request, id: 'que_other' })).toMatchObject(
    { request: { id: 'que_other' } },
  );
});

test('rejects unresolved release, unknown resolution, corrupt transitions, and duplicate request identities', async () => {
  const { store, log, items } = setup();
  await expect(store.resolve('unknown', { rejected: true })).rejects.toThrow(/unknown/);
  await store.open('msg_user', 'native_call', request);
  await expect(store.release(request.id)).rejects.toThrow(/unresolved/);
  const original = structuredClone(items[0]!);
  items.push(structuredClone(original));
  expect(await store.active('msg_user')).toMatchObject({ request });
  items.push({
    kind: 'journal',
    stream: QUESTION_CHECKPOINT_STREAM,
    record: { type: 'resolved', requestId: request.id, resolution: { answers: [['Unknown']] } },
  });
  await expect(new QuestionCheckpointStore(log).active('msg_user')).rejects.toThrow(/option/);
});
