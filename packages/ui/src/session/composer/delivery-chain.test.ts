import { describe, expect, test } from 'bun:test';

import { deliverInOrder, deliveryPending } from './delivery-chain';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A delivery that settles only when the test releases or fails it. */
function heldDelivery<T>(value: T) {
  let release!: () => void;
  let fail!: (error: Error) => void;
  const gate = new Promise<void>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  return {
    deliver: async () => {
      await gate;
      return value;
    },
    release,
    fail,
  };
}

describe('one delivery chain per session', () => {
  test('a session delivers in enqueue order, each delivery after the previous one settles', async () => {
    const events: string[] = [];
    const first = heldDelivery('first');
    const a = deliverInOrder('chain-order', async () => {
      events.push('first starts');
      return first.deliver();
    });
    const b = deliverInOrder('chain-order', async () => {
      events.push('second starts');
      return 'second';
    });
    await tick();
    expect(events).toEqual(['first starts']);

    first.release();
    expect(await a).toBe('first');
    expect(await b).toBe('second');
    expect(events).toEqual(['first starts', 'second starts']);
  });

  test('an idle session starts its delivery in the same tick, and a drained session is idle again', async () => {
    const events: string[] = [];
    expect(deliveryPending('chain-idle')).toBe(false);
    const delivered = deliverInOrder('chain-idle', async () => {
      events.push('started');
      return 'done';
    });
    expect(events).toEqual(['started']);
    expect(deliveryPending('chain-idle')).toBe(true);
    expect(await delivered).toBe('done');
    expect(deliveryPending('chain-idle')).toBe(false);
  });

  test('a delivery that fails settles its link: its caller sees the failure, and the next delivery runs', async () => {
    const first = heldDelivery('never');
    const failed = deliverInOrder('chain-failure', first.deliver);
    const next = deliverInOrder('chain-failure', async () => 'next');
    first.fail(new Error('upload failed'));
    await expect(failed).rejects.toThrow('upload failed');
    expect(await next).toBe('next');
    expect(deliveryPending('chain-failure')).toBe(false);
  });

  test('a delivery that throws before its first await settles its link too', async () => {
    const refused = deliverInOrder('chain-throw', () => {
      throw new Error('refused');
    });
    await expect(refused).rejects.toThrow('refused');
    expect(await deliverInOrder('chain-throw', async () => 'next')).toBe('next');
  });

  test('another session starts at once while one session has a pending delivery', async () => {
    const a = heldDelivery('a');
    const pendingA = deliverInOrder('chain-a', a.deliver);
    const events: string[] = [];
    const b = deliverInOrder('chain-b', async () => {
      events.push('b');
      return 'b';
    });
    expect(events).toEqual(['b']);
    expect(await b).toBe('b');
    expect(deliveryPending('chain-a')).toBe(true);
    expect(deliveryPending('chain-b')).toBe(false);
    a.release();
    expect(await pendingA).toBe('a');
  });
});
