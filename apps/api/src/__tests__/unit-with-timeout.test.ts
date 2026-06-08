/**
 * Unit coverage for `withTimeout` — the wall-clock guard that bounds upstream
 * SDK calls with no native timeout (notably Daytona's `snapshot.get`).
 *
 * Regression context: a hung `snapshot.get` behind the `/sandbox-health`
 * polling endpoint left the request pending until the frontend's 30s client
 * timeout fired, surfacing as the Sentry/Better Stack error
 * "ApiError — Request timed out after 30s: /projects/<id>/sandbox-health".
 * The guard turns that unbounded hang into a fast, catchable rejection so the
 * handler can degrade gracefully.
 */

import { describe, expect, test } from 'bun:test';
import { TimeoutError, withTimeout } from '../shared/with-timeout';

const never = <T>() => new Promise<T>(() => {});

describe('withTimeout', () => {
  test('resolves with the value when the promise wins the race', async () => {
    await expect(withTimeout(Promise.resolve(42), 1_000)).resolves.toBe(42);
  });

  test('propagates rejection when the promise rejects before the deadline', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1_000)).rejects.toThrow(
      'boom',
    );
  });

  test('rejects with TimeoutError when the promise never settles (the hang)', async () => {
    const start = Date.now();
    let caught: unknown;
    try {
      await withTimeout(never<string>(), 20, 'Daytona snapshot.get(foo)');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TimeoutError);
    expect((caught as TimeoutError).timeoutMs).toBe(20);
    expect((caught as Error).message).toContain('Daytona snapshot.get(foo)');
    // It must give up promptly, not block anywhere near a real request timeout.
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  test('a non-positive budget disables the bound (returns the promise as-is)', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 0)).resolves.toBe('ok');
    await expect(withTimeout(Promise.resolve('ok'), -5)).resolves.toBe('ok');
  });

  test('a slow-but-within-budget promise still resolves', async () => {
    const slow = new Promise<string>((r) => setTimeout(() => r('late'), 10));
    await expect(withTimeout(slow, 1_000)).resolves.toBe('late');
  });
});
