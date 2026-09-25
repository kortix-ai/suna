/**
 * A flow attempt that ends releases the work it started.
 *
 * `withFlowDeadline` aborts the attempt's signal on timeout so fixtures stop
 * (see provision-deadline.test.ts). A shared run fixture that failed once is
 * created again by the next caller instead of replaying the same rejection to
 * every later flow: preview run 36067774228 failed FILE-1..7, GH-5..12,
 * RV-1..6, TRG-5, SESS-6 and SESS-11 in 0.0 s each with one cached
 * `project provision returned no id after 14 attempt(s)`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withFlowDeadline } from '../src/core/flow';
import { memoizeUntilRejected } from '../src/fixtures/world';

afterEach(() => {
  vi.useRealTimers();
});

describe('flow deadline', () => {
  it('aborts the attempt signal when the flow exceeds its timeout', async () => {
    vi.useFakeTimers();
    const attempt = new AbortController();

    const run = withFlowDeadline(new Promise<never>(() => undefined), 180_000, 'X', attempt);
    const settled = run.then(() => null, (e: unknown) => e);
    await vi.advanceTimersByTimeAsync(180_000);

    expect(String(await settled)).toMatch(/flow X exceeded 180000ms/);
    expect(attempt.signal.aborted).toBe(true);
    expect(String(attempt.signal.reason)).toMatch(/flow X exceeded 180000ms/);
  });
});

describe('shared run fixtures', () => {
  it('re-creates a shared fixture after a failed attempt instead of replaying the failure', async () => {
    const factory = vi
      .fn()
      .mockRejectedValueOnce(new Error('project provision returned no id after 14 attempt(s)'))
      .mockResolvedValueOnce({ id: 'shared' });
    const shared = memoizeUntilRejected(factory);

    await expect(shared()).rejects.toThrow(/14 attempt/);
    await expect(shared()).resolves.toEqual({ id: 'shared' });
    await expect(shared()).resolves.toEqual({ id: 'shared' });
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight creation between concurrent callers', async () => {
    let resolve: ((value: { id: string }) => void) | undefined;
    const factory = vi.fn(() => new Promise<{ id: string }>((r) => (resolve = r)));
    const shared = memoizeUntilRejected(factory);

    const both = Promise.all([shared(), shared()]);
    resolve?.({ id: 'shared' });

    await expect(both).resolves.toEqual([{ id: 'shared' }, { id: 'shared' }]);
    expect(factory).toHaveBeenCalledTimes(1);
  });
});
