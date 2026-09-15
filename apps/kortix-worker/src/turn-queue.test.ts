import { describe, expect, test } from 'bun:test';
import { TurnQueue } from './turn-queue.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('TurnQueue', () => {
  test('publishes accepted turns immediately but executes them one at a time', async () => {
    const first = deferred();
    const accepted: string[] = [];
    const started: string[] = [];
    const queue = new TurnQueue<{ id: string }>({
      id: (turn) => turn.id,
      onAccepted: (turn) => accepted.push(turn.id),
      run: async (turn) => {
        started.push(turn.id);
        if (turn.id === 'a') await first.promise;
      },
    });

    const a = queue.enqueue({ id: 'a' });
    const b = queue.enqueue({ id: 'b' });

    expect(accepted).toEqual(['a', 'b']);
    expect(started).toEqual(['a']);
    expect(queue.state('a')).toBe('running');
    expect(queue.state('b')).toBe('queued');

    first.resolve();
    expect(await a.done).toBe('completed');
    expect(await b.done).toBe('completed');
    expect(started).toEqual(['a', 'b']);
  });

  test('cancels a queued turn before it can reach the model', async () => {
    const first = deferred();
    const started: string[] = [];
    const queue = new TurnQueue<{ id: string }>({
      id: (turn) => turn.id,
      run: async (turn) => {
        started.push(turn.id);
        if (turn.id === 'a') await first.promise;
      },
    });

    const a = queue.enqueue({ id: 'a' });
    const b = queue.enqueue({ id: 'b' });
    expect(queue.cancel('b')).toBe('cancelled');
    expect(await b.done).toBe('cancelled');

    first.resolve();
    expect(await a.done).toBe('completed');
    await queue.waitForIdle();
    expect(started).toEqual(['a']);
    expect(queue.state('b')).toBe('missing');
  });

  test('refuses to cancel a running turn', async () => {
    const gate = deferred();
    const queue = new TurnQueue<{ id: string }>({
      id: (turn) => turn.id,
      run: () => gate.promise,
    });

    const running = queue.enqueue({ id: 'a' });
    expect(queue.cancel('a')).toBe('running');
    gate.resolve();
    expect(await running.done).toBe('completed');
  });

  test('coalesces a duplicate active message id', async () => {
    const gate = deferred();
    let accepted = 0;
    let runs = 0;
    const queue = new TurnQueue<{ id: string }>({
      id: (turn) => turn.id,
      onAccepted: () => {
        accepted += 1;
      },
      run: async () => {
        runs += 1;
        await gate.promise;
      },
    });

    const first = queue.enqueue({ id: 'same' });
    const duplicate = queue.enqueue({ id: 'same' });
    expect(first.accepted).toBe(true);
    expect(duplicate.accepted).toBe(false);
    expect(duplicate.done).toBe(first.done);
    expect(accepted).toBe(1);
    expect(runs).toBe(1);
    gate.resolve();
    expect(await duplicate.done).toBe('completed');
  });

  test('propagates a cancellation selected by the run barrier', async () => {
    const queue = new TurnQueue<{ id: string }>({
      id: (turn) => turn.id,
      run: async () => 'cancelled',
    });

    expect(await queue.enqueue({ id: 'a' }).done).toBe('cancelled');
  });
});
