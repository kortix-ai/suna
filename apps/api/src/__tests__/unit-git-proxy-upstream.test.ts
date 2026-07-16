/**
 * Regression tests for the git proxy's transient-upstream handling.
 *
 * Background: Better Stack pattern `df7a31d4…` ("The socket connection was
 * closed unexpectedly. For more information, pass `verbose: true` in the second
 * argument to fetch()") was a prod one-off that escaped Bun's fetch streamer to
 * the global uncaught-exception handler — it had NO source frame because it
 * threw outside the route's try/catch while streaming `res.body` for
 * `GET /v1/git/<id>.git/info/refs`. The fix buffers + bounded-retries the
 * idempotent ref-discovery body so the mid-stream socket close is caught here.
 */
import { describe, expect, mock, test } from 'bun:test';
import { fetchUpstreamBuffered, isTransientUpstreamError } from '../git-proxy/upstream';

describe('isTransientUpstreamError', () => {
  test('classifies Bun socket-close + common transient network errors', () => {
    expect(
      isTransientUpstreamError(
        new Error(
          'The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()',
        ),
      ),
    ).toBe(true);
    expect(isTransientUpstreamError(new Error('fetch failed: other side closed'))).toBe(true);
    expect(isTransientUpstreamError(new Error('connect ECONNRESET 10.0.0.1:443'))).toBe(true);
    expect(isTransientUpstreamError(new Error('connect ETIMEDOUT'))).toBe(true);
  });

  test('does not classify non-transient errors as transient', () => {
    expect(isTransientUpstreamError(new Error('Not found'))).toBe(false);
    expect(isTransientUpstreamError(new TypeError('invalid url'))).toBe(false);
    expect(isTransientUpstreamError('')).toBe(false);
    expect(isTransientUpstreamError(undefined)).toBe(false);
  });
});

describe('fetchUpstreamBuffered', () => {
  const mkRes = (status: number, body: string) =>
    new Response(new TextEncoder().encode(body), {
      status,
      headers: { 'content-type': 'application/x-git-upload-pack-advertisement' },
    });

  test('retries a transient socket close and succeeds on a later attempt', async () => {
    const fetchImpl = mock((_target: string) => {
      callCount++;
      if (callCount < 3) {
        throw new Error(
          'The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()',
        );
      }
      return Promise.resolve(mkRes(200, '000eversion 2'));
    });
    let callCount = 0;
    const sleeps: number[] = [];
    const res = await fetchUpstreamBuffered(
      'https://upstream/repo.git/info/refs?service=git-upload-pack',
      { method: 'GET', headers: {} },
      {
        retries: 3,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleepFn: async (ms) => void sleeps.push(ms),
      },
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('000eversion 2');
    expect(callCount).toBe(3);
    // bounded backoff: 250ms then 500ms
    expect(sleeps).toEqual([250, 500]);
  });

  test('does NOT retry a non-transient error — throws immediately', async () => {
    const fetchImpl = mock(() => Promise.reject(new Error('Not found')));
    const sleepFn = mock(async (_ms: number) => undefined);
    await expect(
      fetchUpstreamBuffered(
        'https://upstream/info/refs',
        { method: 'GET', headers: {} },
        {
          retries: 3,
          fetchImpl: fetchImpl as unknown as typeof fetch,
          sleepFn: sleepFn as unknown as (ms: number) => Promise<void>,
        },
      ),
    ).rejects.toThrow('Not found');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  test('gives up after retries are exhausted and rethrows the last transient error', async () => {
    const fetchImpl = mock(() =>
      Promise.reject(new Error('The socket connection was closed unexpectedly')),
    );
    const sleepFn = mock(async (_ms: number) => undefined);
    await expect(
      fetchUpstreamBuffered(
        'https://upstream/info/refs',
        { method: 'GET', headers: {} },
        {
          retries: 2,
          fetchImpl: fetchImpl as unknown as typeof fetch,
          sleepFn: sleepFn as unknown as (ms: number) => Promise<void>,
        },
      ),
    ).rejects.toThrow('The socket connection was closed unexpectedly');
    // 1 initial + 2 retries = 3 attempts
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleepFn).toHaveBeenCalledTimes(2);
  });

  test('buffers the body so a mid-stream close during arrayBuffer() is retried', async () => {
    // Simulate fetch resolving but the body read throwing a transient socket
    // close (the exact escape path that produced df7a31d4…).
    let callCount = 0;
    const fetchImpl = mock((_target: string) => {
      callCount++;
      const res = {
        status: 200,
        headers: new Headers({ 'content-type': 'application/x-git-upload-pack-advertisement' }),
        arrayBuffer: () =>
          callCount === 1
            ? Promise.reject(new Error('The socket connection was closed unexpectedly'))
            : Promise.resolve(new TextEncoder().encode('000eversion 2').buffer),
      };
      return Promise.resolve(res as unknown as Response);
    });
    const res = await fetchUpstreamBuffered(
      'https://upstream/info/refs',
      { method: 'GET', headers: {} },
      {
        retries: 2,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleepFn: async () => undefined,
      },
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('000eversion 2');
    expect(callCount).toBe(2);
  });
});
