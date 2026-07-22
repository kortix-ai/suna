import { afterEach, describe, expect, test } from 'bun:test';
import { usePendingQueueStore } from './pending-queue-store';

afterEach(() => {
  usePendingQueueStore.getState().consumePendingQueue();
});

describe('pending queue store (boot-time queued messages)', () => {
  test('queueMessage preserves order and assigns unique ids', () => {
    const s = usePendingQueueStore.getState();
    s.queueMessage('first');
    s.queueMessage('second');
    const messages = usePendingQueueStore.getState().messages;
    expect(messages.map((m) => m.text)).toEqual(['first', 'second']);
    expect(new Set(messages.map((m) => m.id)).size).toBe(2);
  });

  test('queueMessage carries files and mentions through untouched', () => {
    const file = {
      kind: 'local',
      localUrl: 'blob:mock',
      file: { name: 'a.txt' },
    } as never;
    const mention = { path: 'src/a.txt', label: 'a.txt' } as never;
    usePendingQueueStore.getState().queueMessage('with attachments', [file], [mention]);
    const [queued] = usePendingQueueStore.getState().messages;
    expect(queued.files).toEqual([file]);
    expect(queued.mentions).toEqual([mention]);
  });

  test('removeMessage drops only the targeted message', () => {
    const s = usePendingQueueStore.getState();
    s.queueMessage('keep');
    s.queueMessage('drop');
    const dropId = usePendingQueueStore.getState().messages[1].id;
    s.removeMessage(dropId);
    expect(usePendingQueueStore.getState().messages.map((m) => m.text)).toEqual(['keep']);
  });

  test('consumePendingQueue returns everything and empties the store', () => {
    const s = usePendingQueueStore.getState();
    s.queueMessage('one');
    s.queueMessage('two');
    const consumed = s.consumePendingQueue();
    expect(consumed.map((m) => m.text)).toEqual(['one', 'two']);
    expect(usePendingQueueStore.getState().messages).toEqual([]);
    expect(usePendingQueueStore.getState().consumePendingQueue()).toEqual([]);
  });
});
