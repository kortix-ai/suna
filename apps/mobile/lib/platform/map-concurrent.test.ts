import { describe, expect, test } from 'bun:test';
import { mapConcurrent } from './map-concurrent';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('mapConcurrent', () => {
  test('preserves input order when calls finish out of order', async () => {
    const delays = [30, 5, 20, 0, 10];
    const result = await mapConcurrent(delays, 4, async (ms, index) => {
      await new Promise((r) => setTimeout(r, ms));
      return `${index}:${ms}`;
    });
    expect(result).toEqual(['0:30', '1:5', '2:20', '3:0', '4:10']);
  });

  test('runs at most `limit` calls at once and starts the next when one ends', async () => {
    const gates = Array.from({ length: 10 }, () => deferred<number>());
    let inFlight = 0;
    let maxInFlight = 0;
    const started: number[] = [];
    const run = mapConcurrent(gates, 4, async (gate, index) => {
      started.push(index);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        return await gate.promise;
      } finally {
        inFlight -= 1;
      }
    });

    await tick();
    expect(started).toEqual([0, 1, 2, 3]);

    gates[2].resolve(2);
    await tick();
    expect(started).toEqual([0, 1, 2, 3, 4]);

    gates.forEach((gate, index) => gate.resolve(index));
    expect(await run).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(maxInFlight).toBe(4);
  });

  test('a per-item catch keeps one failure from rejecting the rest', async () => {
    const result = await mapConcurrent([1, 2, 3, 4, 5], 4, (n) =>
      (n === 3 ? Promise.reject(new Error('boom')) : Promise.resolve([n])).catch(() => [])
    );
    expect(result).toEqual([[1], [2], [], [4], [5]]);
  });

  test('an uncaught failure rejects with that error and starts no further calls', async () => {
    const started: number[] = [];
    const run = mapConcurrent([0, 1, 2, 3, 4, 5, 6], 2, async (n) => {
      started.push(n);
      if (n === 1) throw new Error('boom');
      await tick();
      return n;
    });
    await expect(run).rejects.toThrow('boom');
    await tick();
    await tick();
    expect(started).toEqual([0, 1]);
  });

  test('returns an empty array for no items without calling fn', async () => {
    let calls = 0;
    expect(await mapConcurrent([], 4, async () => ++calls)).toEqual([]);
    expect(calls).toBe(0);
  });

  test('treats a limit below 1 as 1', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await mapConcurrent([1, 2, 3], 0, async (n) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await tick();
      inFlight -= 1;
      return n;
    });
    expect(maxInFlight).toBe(1);
  });
});
