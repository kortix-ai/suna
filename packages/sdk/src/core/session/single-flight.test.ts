import { describe, expect, test } from 'bun:test';

import { createTickSingleFlight } from './single-flight';

const nextMacrotask = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createTickSingleFlight', () => {
  test('same-tick callers for one key share one read', async () => {
    const run = createTickSingleFlight<number>();
    const gate = deferred<number>();
    let reads = 0;
    const read = () => {
      reads += 1;
      return gate.promise;
    };
    const a = run('k', read);
    const b = run('k', read);
    const c = run('k', read);
    gate.resolve(7);
    expect(await Promise.all([a, b, c])).toEqual([7, 7, 7]);
    expect(reads).toBe(1);
  });

  test('a read its caller CANCELLED is never joined, even in the same tick', async () => {
    // A mutation cancels the in-flight list read before it writes (TanStack
    // `cancelQueries`), then its settle reads again. That read asks a question
    // the cancelled one cannot answer; joining it inherits a request nobody
    // awaits any more — one that may never settle.
    const run = createTickSingleFlight<number>();
    const stuck = deferred<number>();
    const fresh = deferred<number>();
    const controller = new AbortController();
    let reads = 0;
    void run('k', () => {
      reads += 1;
      return stuck.promise;
    }, controller.signal);
    controller.abort();
    const next = run('k', () => {
      reads += 1;
      return fresh.promise;
    });
    fresh.resolve(9);
    expect(await next).toBe(9);
    expect(reads).toBe(2);
  });

  test('guard: an un-cancelled same-tick read is still shared', async () => {
    const run = createTickSingleFlight<number>();
    const gate = deferred<number>();
    const controller = new AbortController();
    let reads = 0;
    const read = () => {
      reads += 1;
      return gate.promise;
    };
    const a = run('k', read, controller.signal);
    const b = run('k', read);
    gate.resolve(4);
    expect(await Promise.all([a, b])).toEqual([4, 4]);
    expect(reads).toBe(1);
  });

  test('a caller in a later tick starts its own read, even while one is in flight', async () => {
    const run = createTickSingleFlight<number>();
    const gates = [deferred<number>(), deferred<number>()];
    let reads = 0;
    const read = () => gates[reads++]!.promise;
    const a = run('k', read);
    await nextMacrotask();
    const b = run('k', read);
    expect(reads).toBe(2);
    gates[0]!.resolve(1);
    gates[1]!.resolve(2);
    expect(await a).toBe(1);
    expect(await b).toBe(2);
  });

  test('keys are independent', () => {
    const run = createTickSingleFlight<number>();
    let reads = 0;
    const read = () => {
      reads += 1;
      return new Promise<number>(() => {});
    };
    void run('a', read);
    void run('b', read);
    expect(reads).toBe(2);
  });

  test('a rejection reaches every joined caller and frees the key', async () => {
    const run = createTickSingleFlight<number>();
    const gate = deferred<number>();
    let reads = 0;
    const read = () => {
      reads += 1;
      return reads === 1 ? gate.promise : Promise.resolve(9);
    };
    const a = run('k', read);
    const b = run('k', read);
    gate.reject(new Error('boom'));
    await expect(a).rejects.toThrow('boom');
    await expect(b).rejects.toThrow('boom');
    expect(await run('k', read)).toBe(9);
    expect(reads).toBe(2);
  });

  test('a settled read is never re-served, even inside the same tick', async () => {
    const run = createTickSingleFlight<number>((callback) => {
      // A schedule that never fires: the only thing that can end the flight
      // is its own settle.
      void callback;
    });
    let reads = 0;
    const read = () => Promise.resolve(++reads);
    expect(await run('k', read)).toBe(1);
    expect(await run('k', read)).toBe(2);
  });
});
