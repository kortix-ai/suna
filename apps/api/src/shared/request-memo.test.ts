import { describe, expect, test } from 'bun:test';
import { memoInRequest, withRequestMemo } from './request-memo';

describe('request memo', () => {
  test('one load per key inside a request; a prefetch is reused', async () => {
    let loads = 0;
    const read = () => memoInRequest('k', async () => { loads += 1; return loads; });
    const [a, b] = await withRequestMemo(async () => {
      void read();
      return [await read(), await read()];
    });
    expect([a, b, loads]).toEqual([1, 1, 1]);
  });

  test('nothing outlives the request, and outside a scope every call loads', async () => {
    let loads = 0;
    const read = () => memoInRequest('k', async () => ++loads);
    await withRequestMemo(read);
    await withRequestMemo(read);
    await read();
    await read();
    expect(loads).toBe(4);
  });

  test('a failed prefetch nobody awaited does not reject unhandled; a later caller sees the error', async () => {
    await withRequestMemo(async () => {
      void memoInRequest('k', async () => { throw new Error('db down'); });
      await expect(memoInRequest('k', async () => 'never')).rejects.toThrow('db down');
    });
  });
});
