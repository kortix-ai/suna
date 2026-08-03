import { describe, expect, test } from 'bun:test';

import { createSendQueue, type SendPhase } from './send-queue';

const SID = 'ses_1';

/** A hand-driven session: busy flips only when a test says so. */
function harness() {
  let busy = false;
  const phases: Array<[string, SendPhase]> = [];
  const dispatched: string[] = [];
  const resolvers = new Map<string, { resolve: () => void; reject: (e?: unknown) => void }>();

  const queue = createSendQueue({
    isBusy: () => busy,
    onPhase: (_sid, messageId, phase) => phases.push([messageId, phase]),
  });

  /** A dispatch that stays pending until the test settles it. */
  const send = (messageId: string) => ({
    messageId,
    dispatch: () =>
      new Promise<void>((resolve, reject) => {
        dispatched.push(messageId);
        resolvers.set(messageId, { resolve, reject });
      }),
  });

  return {
    queue,
    phases,
    dispatched,
    setBusy: (next: boolean) => {
      busy = next;
    },
    settle: async (messageId: string) => {
      resolvers.get(messageId)?.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
    fail: async (messageId: string) => {
      resolvers.get(messageId)?.reject(new Error('boom'));
      await Promise.resolve();
      await Promise.resolve();
    },
    send,
  };
}

describe('createSendQueue — an idle session', () => {
  test('sends immediately rather than adding latency for nothing', () => {
    const h = harness();
    expect(h.queue.submit(SID, h.send('msg_a'))).toBe('sending');
    expect(h.dispatched).toEqual(['msg_a']);
    expect(h.queue.pending(SID)).toEqual([]);
  });

  test('reports sent once the dispatch resolves', async () => {
    const h = harness();
    h.queue.submit(SID, h.send('msg_a'));
    await h.settle('msg_a');
    expect(h.phases).toEqual([
      ['msg_a', 'sending'],
      ['msg_a', 'sent'],
    ]);
  });
});

describe('createSendQueue — a busy session', () => {
  test('holds the prompt instead of racing the run', () => {
    const h = harness();
    h.setBusy(true);

    expect(h.queue.submit(SID, h.send('msg_a'))).toBe('queued');
    expect(h.dispatched).toEqual([]);
    expect(h.queue.pending(SID)).toEqual(['msg_a']);
    expect(h.phases).toEqual([['msg_a', 'queued']]);
  });

  test('dispatches on drain, once the run finishes', () => {
    const h = harness();
    h.setBusy(true);
    h.queue.submit(SID, h.send('msg_a'));

    h.setBusy(false);
    h.queue.drain(SID);

    expect(h.dispatched).toEqual(['msg_a']);
    expect(h.queue.pending(SID)).toEqual([]);
  });

  test('drain while still busy is a no-op — it does not jump the run', () => {
    const h = harness();
    h.setBusy(true);
    h.queue.submit(SID, h.send('msg_a'));

    h.queue.drain(SID);
    expect(h.dispatched).toEqual([]);
  });

  test('one at a time, in the order they were written', async () => {
    const h = harness();
    h.setBusy(true);
    h.queue.submit(SID, h.send('msg_a'));
    h.queue.submit(SID, h.send('msg_b'));
    h.queue.submit(SID, h.send('msg_c'));
    expect(h.queue.pending(SID)).toEqual(['msg_a', 'msg_b', 'msg_c']);

    h.setBusy(false);
    h.queue.drain(SID);
    expect(h.dispatched).toEqual(['msg_a']);

    // The run for msg_a is under way; nothing else may go out yet.
    h.setBusy(true);
    await h.settle('msg_a');
    h.queue.drain(SID);
    expect(h.dispatched).toEqual(['msg_a']);

    h.setBusy(false);
    h.queue.drain(SID);
    expect(h.dispatched).toEqual(['msg_a', 'msg_b']);
  });

  test('an idle-instant send still queues behind anything already waiting', () => {
    // Ordering beats latency: a prompt written third must not overtake two
    // that are waiting just because the session blinked idle.
    const h = harness();
    h.setBusy(true);
    h.queue.submit(SID, h.send('msg_a'));

    h.setBusy(false);
    expect(h.queue.submit(SID, h.send('msg_b'))).toBe('queued');
    expect(h.dispatched).toEqual([]);
    expect(h.queue.pending(SID)).toEqual(['msg_a', 'msg_b']);
  });
});

describe('createSendQueue — failure does not wedge the queue', () => {
  test('a failed send is reported and the next one still goes out', async () => {
    const h = harness();
    h.queue.submit(SID, h.send('msg_a'));
    h.queue.submit(SID, h.send('msg_b'));

    await h.fail('msg_a');

    expect(h.phases).toContainEqual(['msg_a', 'failed']);
    expect(h.dispatched).toEqual(['msg_a', 'msg_b']);
  });
});

describe('createSendQueue — cancellation', () => {
  test('cancel drops a held send and leaves the rest in order', () => {
    const h = harness();
    h.setBusy(true);
    h.queue.submit(SID, h.send('msg_a'));
    h.queue.submit(SID, h.send('msg_b'));
    h.queue.submit(SID, h.send('msg_c'));

    expect(h.queue.cancel(SID, 'msg_b')).toBe(true);
    expect(h.queue.pending(SID)).toEqual(['msg_a', 'msg_c']);
  });

  test('cancelling something that is not held reports it', () => {
    const h = harness();
    expect(h.queue.cancel(SID, 'msg_nope')).toBe(false);
  });

  test('clear abandons everything for that session only', () => {
    const h = harness();
    h.setBusy(true);
    h.queue.submit(SID, h.send('msg_a'));
    h.queue.submit('ses_2', h.send('msg_other'));

    h.queue.clear(SID);

    expect(h.queue.pending(SID)).toEqual([]);
    expect(h.queue.pending('ses_2')).toEqual(['msg_other']);
  });
});

describe('createSendQueue — sessions do not interfere', () => {
  test('a busy session holding prompts does not block an idle one', () => {
    let busySessions = new Set([SID]);
    const dispatched: string[] = [];
    const queue = createSendQueue({ isBusy: (sid) => busySessions.has(sid) });
    const send = (id: string) => ({
      messageId: id,
      dispatch: async () => {
        dispatched.push(id);
      },
    });

    expect(queue.submit(SID, send('msg_held'))).toBe('queued');
    expect(queue.submit('ses_2', send('msg_free'))).toBe('sending');
    expect(dispatched).toEqual(['msg_free']);
  });
});
