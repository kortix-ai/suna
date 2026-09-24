/**
 * A project provision stops when its flow attempt ends, and its rate-limit
 * budget counts every second it waits.
 *
 * Preview runs 36067774228 and 36068206735 (2026-09-24) hit GitHub's secondary
 * rate limit, and 61 and 67 flows failed with a flow timeout. A provision that
 * was still queued or sleeping when its flow timed out kept its semaphore slot
 * and kept retrying after the flow was already reported. The API lane then ran
 * ~61 minutes instead of the usual ~20.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '../src/core/client';
import { transientBreaker } from '../src/core/client';

let provisionProject: typeof import('../src/fixtures/provision').provisionProject;

function response(statusCode: number, json?: unknown, headers: Record<string, string> = {}) {
  return {
    statusCode,
    text: () => JSON.stringify(json ?? {}),
    json: <T>() => json as T,
    header: (name: string) => headers[name.toLowerCase()],
  };
}

const rateLimited = (seconds: number) =>
  response(503, { error: 'secondary rate limit', code: 'GITHUB_RATE_LIMITED' }, { 'retry-after': String(seconds) });

function clientWithPost(post: unknown): Client {
  return { post } as unknown as Client;
}

beforeEach(async () => {
  vi.stubEnv('KE2E_PROVISION_CONCURRENCY', '1');
  vi.stubEnv('KE2E_PROVISION_MIN_INTERVAL_MS', '0');
  vi.stubEnv('KE2E_PROVISION_RATE_LIMIT_BUDGET_MS', '600000');
  transientBreaker.reset();
  vi.resetModules();
  ({ provisionProject } = await import('../src/fixtures/provision'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('provision lifetime is bounded by its flow attempt', () => {
  it('drops a queued provision when its flow attempt ends, and frees nothing it never held', async () => {
    let releaseFirst: (() => void) | undefined;
    const post = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirst = () => resolve(response(200, { project_id: 'first' }));
          }),
      )
      .mockResolvedValue(response(200, { project_id: 'third' }));

    const first = provisionProject(clientWithPost(post), { name: 'first' });
    const attempt = new AbortController();
    const queued = provisionProject(clientWithPost(post), { name: 'queued' }, { signal: attempt.signal });
    await new Promise((resolve) => setTimeout(resolve, 5));

    attempt.abort(new Error('flow X exceeded 180000ms'));
    await expect(queued).rejects.toThrow(/abandoned.*flow X exceeded 180000ms/);

    releaseFirst?.();
    await expect(first).resolves.toBe('first');
    // The slot the first provision held is handed to the next caller, not to
    // the abandoned waiter.
    await expect(provisionProject(clientWithPost(post), { name: 'third' })).resolves.toBe('third');
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('stops a provision that is sleeping out a rate limit when its flow attempt ends', async () => {
    vi.useFakeTimers();
    const post = vi.fn().mockResolvedValue(rateLimited(120));
    const attempt = new AbortController();

    const result = provisionProject(clientWithPost(post), { name: 'x' }, { signal: attempt.signal });
    const settled = result.then(() => null, (e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    attempt.abort(new Error('flow X exceeded 180000ms'));
    await vi.advanceTimersByTimeAsync(0);

    expect(String(await settled)).toMatch(/abandoned/);
    expect(post).toHaveBeenCalledTimes(1);
    // The next provision is not blocked by a slot the abandoned one kept.
    const next = provisionProject(clientWithPost(vi.fn().mockResolvedValue(response(200, { project_id: 'n' }))), {
      name: 'n',
    });
    await vi.runAllTimersAsync();
    await expect(next).resolves.toBe('n');
  });

  it('counts a cooldown another provision imposed against its own budget', async () => {
    vi.stubEnv('KE2E_PROVISION_CONCURRENCY', '2');
    vi.stubEnv('KE2E_PROVISION_RATE_LIMIT_BUDGET_MS', '60000');
    vi.resetModules();
    ({ provisionProject } = await import('../src/fixtures/provision'));
    vi.useFakeTimers();
    const postA = vi.fn().mockResolvedValue(rateLimited(300));
    const postB = vi.fn().mockResolvedValue(response(200, { project_id: 'b' }));

    const a = provisionProject(clientWithPost(postA), { name: 'a' }).then(() => null, (e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    const started = Date.now();
    const b = provisionProject(clientWithPost(postB), { name: 'b' }).then(() => null, (e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);

    // GitHub asked for 300 s; the budget is 60 s. B gives up at once with the
    // real reason instead of sleeping 300 s and then asking again.
    expect(String(await b)).toMatch(/rate-limit cooldown.*exceeds.*budget/);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(postB).not.toHaveBeenCalled();
    expect(String(await a)).toMatch(/HTTP 503.*secondary rate limit/);
  });
});
