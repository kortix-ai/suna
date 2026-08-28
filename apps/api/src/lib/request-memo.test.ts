import { describe, expect, test } from 'bun:test';
import {
  invalidateRequestMemo,
  requestMemo,
  runWithContext,
} from './request-context';

/**
 * `requestMemo` exists to collapse the SAME read issued twice inside one
 * request (the project git connection is loaded 2–3× per project route because
 * four independent helpers each reach for it). Unlike a TTL cache it must never
 * answer with a value read before this request began — that is the whole reason
 * it is request-scoped and not `ttlMemo`.
 */
describe('requestMemo', () => {
  test('runs the loader once per key inside one request', async () => {
    let calls = 0;
    const load = () => requestMemo('k', async () => ++calls);

    const [a, b, c] = await runWithContext('GET', '/x', async () =>
      Promise.all([load(), load(), load()]),
    );

    expect(calls).toBe(1);
    expect([a, b, c]).toEqual([1, 1, 1]);
  });

  test('two requests never share an entry', async () => {
    let calls = 0;
    const load = () => requestMemo('k', async () => ++calls);

    const first = await runWithContext('GET', '/x', load);
    const second = await runWithContext('GET', '/x', load);

    expect(calls).toBe(2);
    expect(first).toBe(1);
    expect(second).toBe(2);
  });

  test('separate keys do not collide', async () => {
    const seen = await runWithContext('GET', '/x', async () => [
      await requestMemo('a', async () => 'A'),
      await requestMemo('b', async () => 'B'),
    ]);

    expect(seen).toEqual(['A', 'B']);
  });

  test('a rejection is not cached — the next call retries', async () => {
    let calls = 0;
    const load = () =>
      requestMemo('k', async () => {
        calls += 1;
        if (calls === 1) throw new Error('transient');
        return 'ok';
      });

    const result = await runWithContext('GET', '/x', async () => {
      await expect(load()).rejects.toThrow('transient');
      return load();
    });

    expect(calls).toBe(2);
    expect(result).toBe('ok');
  });

  test('invalidate makes a read AFTER a write in the same request see the write', async () => {
    let stored = 'before';
    let reads = 0;
    const read = () =>
      requestMemo('k', async () => {
        reads += 1;
        return stored;
      });

    const seen = await runWithContext('GET', '/x', async () => {
      const first = await read();
      stored = 'after';
      invalidateRequestMemo('k');
      return [first, await read()];
    });

    expect(seen).toEqual(['before', 'after']);
    expect(reads).toBe(2);
  });

  test('outside a request it degrades to a plain call, never a process-wide cache', async () => {
    let calls = 0;
    const load = () => requestMemo('k', async () => ++calls);

    expect(await load()).toBe(1);
    expect(await load()).toBe(2);
  });
});
