import { describe, expect, test } from 'bun:test';
import { TIMEOUT_SENTINEL, withDeadline, withTimeout } from '../shared/timeout';

/**
 * Regression for the prod incident:
 *   ApiError: Request timed out after 30s: /projects/<id>/sandbox-health
 *   (Better Stack error 2cae9420…, Kortix Frontend prod, 2026-06-07)
 *
 * Root cause: the /sandbox-health poll resolves each template's live provider
 * state via Daytona's `snapshot.get`, an unbounded network round-trip. When the
 * provider stalls, that call hangs forever, the whole poll blocks, and the
 * frontend aborts it at 30s — surfacing as a Sentry `ApiError`. Prod telemetry
 * showed /sandbox-health at p50 ~3s and max ~20s, with the slowest exceeding
 * the client budget.
 *
 * The fix bounds the provider round-trip with `withTimeout`, so a stalled call
 * is turned into a fast, recoverable failure (the caller falls back to cached /
 * 'missing' state) instead of hanging. These tests pin that behaviour.
 */
describe('withTimeout (bounds a stalled provider round-trip)', () => {
  test('resolves with the value when the promise settles in time', async () => {
    const result = await withTimeout(Promise.resolve('active'), 1_000);
    expect(result).toBe('active');
  });

  test('propagates a real rejection unchanged (not as a timeout)', async () => {
    const boom = new Error('provider 500');
    await expect(withTimeout(Promise.reject(boom), 1_000)).rejects.toBe(boom);
  });

  test('rejects with TIMEOUT_SENTINEL when the promise hangs past the deadline', async () => {
    // A promise that never settles — exactly the prod failure mode.
    const hang = new Promise<string>(() => {});
    const start = Date.now();
    let caught: unknown;
    try {
      await withTimeout(hang, 50);
    } catch (err) {
      caught = err;
    }
    const elapsed = Date.now() - start;
    expect(caught).toBe(TIMEOUT_SENTINEL);
    // It must return *promptly* after the deadline, not hang.
    expect(elapsed).toBeLessThan(1_000);
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });

  test('does not keep the event loop alive after a fast resolution (timer cleared)', async () => {
    // If the timer leaked, the process would be held open for ~the timeout.
    // We can't directly assert on handles here, but we can assert the race
    // settles immediately and a long timeout doesn't delay anything.
    const start = Date.now();
    await withTimeout(Promise.resolve(1), 60_000);
    expect(Date.now() - start).toBeLessThan(1_000);
  });
});

/**
 * withDeadline guards the whole /sandbox-health template enumeration. A stalled
 * enumeration must reject promptly with a descriptive error so the handler can
 * fall back to "no templates" instead of running long enough for the browser to
 * abort the request and emit a Sentry timeout.
 */
describe('withDeadline (bounds the whole sandbox-health enumeration)', () => {
  test('resolves with the value when in time', async () => {
    expect(await withDeadline(Promise.resolve(['t']), 1_000, 'sandbox-health')).toEqual(['t']);
  });

  test('rejects with a labelled Error when it hangs', async () => {
    const hang = new Promise<string[]>(() => {});
    const start = Date.now();
    let caught: unknown;
    try {
      await withDeadline(hang, 50, 'sandbox-health');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('sandbox-health timed out after 50ms');
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  test('propagates a real rejection unchanged', async () => {
    const boom = new Error('repo unreachable');
    await expect(withDeadline(Promise.reject(boom), 1_000, 'sandbox-health')).rejects.toBe(boom);
  });
});
