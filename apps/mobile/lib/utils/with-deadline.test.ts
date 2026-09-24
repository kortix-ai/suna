import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';

import { createDeadlineFetch, withDeadline, type FetchFunction } from './with-deadline';

const TIMED_OUT = Symbol('timed-out');

describe('withDeadline', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('resolves with the value when the promise settles before the deadline', async () => {
    const result = withDeadline(Promise.resolve('session'), 8_000, TIMED_OUT);
    expect(await result).toBe('session');
  });

  test('resolves with the fallback when the deadline passes first', async () => {
    const never = new Promise<string>(() => {});
    const result = withDeadline(never, 8_000, TIMED_OUT);
    jest.advanceTimersByTime(8_000);
    expect(await result).toBe(TIMED_OUT);
  });

  test('does not resolve with the fallback one tick before the deadline', async () => {
    let late: (value: string) => void = () => {};
    const pending = new Promise<string>((resolve) => {
      late = resolve;
    });
    const result = withDeadline(pending, 8_000, TIMED_OUT);
    jest.advanceTimersByTime(7_999);
    late('session');
    expect(await result).toBe('session');
  });

  test('rejects with the original error when the promise rejects before the deadline', async () => {
    const failure = new Error('storage read failed');
    const result = withDeadline(Promise.reject(failure), 8_000, TIMED_OUT);
    await expect(result).rejects.toBe(failure);
  });

  test('clears its timer once the promise settles', async () => {
    await withDeadline(Promise.resolve(1), 8_000, TIMED_OUT);
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('createDeadlineFetch', () => {
  const isAuth = (url: string) => url.includes('/auth/v1/');

  function hangingFetch() {
    const calls: { url: string; signal?: AbortSignal | null }[] = [];
    const fetchImpl: FetchFunction = (input, init) => {
      calls.push({ url: String(input), signal: init?.signal });
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    };
    return { calls, fetchImpl };
  }

  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('aborts a matching request after the timeout', async () => {
    const { calls, fetchImpl } = hangingFetch();
    const deadlineFetch = createDeadlineFetch(fetchImpl, { timeoutMs: 15_000, shouldTimeout: isAuth });
    const request = deadlineFetch('https://x.supabase.co/auth/v1/token?grant_type=refresh_token');
    jest.advanceTimersByTime(15_000);
    await expect(request).rejects.toThrow('aborted');
    expect(calls[0].signal?.aborted).toBe(true);
  });

  test('passes a non-matching request through without a signal or timer', async () => {
    const { calls, fetchImpl } = hangingFetch();
    const deadlineFetch = createDeadlineFetch(fetchImpl, { timeoutMs: 15_000, shouldTimeout: isAuth });
    void deadlineFetch('https://x.supabase.co/storage/v1/object/avatars/a.png', { method: 'POST' });
    expect(calls[0].signal).toBeUndefined();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('forwards an abort from the caller signal', async () => {
    const { calls, fetchImpl } = hangingFetch();
    const deadlineFetch = createDeadlineFetch(fetchImpl, { timeoutMs: 15_000, shouldTimeout: isAuth });
    const caller = new AbortController();
    const request = deadlineFetch('https://x.supabase.co/auth/v1/user', { signal: caller.signal });
    caller.abort();
    await expect(request).rejects.toThrow('aborted');
    expect(calls[0].signal?.aborted).toBe(true);
  });

  test('clears the timer when a matching request settles', async () => {
    const fetchImpl: FetchFunction = async () => new Response('{}');
    const deadlineFetch = createDeadlineFetch(fetchImpl, { timeoutMs: 15_000, shouldTimeout: isAuth });
    await deadlineFetch('https://x.supabase.co/auth/v1/user');
    expect(jest.getTimerCount()).toBe(0);
  });
});
