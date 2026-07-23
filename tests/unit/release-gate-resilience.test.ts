import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Client, isKe2eRetryableError } from '../src/core/client';
import { waitFor } from '../src/core/poll';
import { provisionProject } from '../src/fixtures/provision';

function response(statusCode: number, bodyText: string, json?: unknown) {
  return {
    statusCode,
    text: () => bodyText,
    json: <T>() => json as T,
  };
}

async function settleTimers<T>(promise: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return promise;
}

function clientWithPost(post: unknown): Client {
  return { post } as unknown as Client;
}

describe('release gate transient failure resilience', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries project provisioning after an HTTP 502 response', async () => {
    vi.useFakeTimers();
    const post = vi
      .fn()
      .mockResolvedValueOnce(response(502, '<html>Bad gateway</html>'))
      .mockResolvedValueOnce(
        response(200, '{"project_id":"project-1"}', { project_id: 'project-1' }),
      );

    const result = provisionProject(clientWithPost(post), { name: 'release-gate-test' });

    await expect(settleTimers(result)).resolves.toBe('project-1');
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('retries project provisioning after a marked network error', async () => {
    vi.useFakeTimers();
    const networkError = Object.assign(new Error('request timed out'), {
      ke2eRetryable: true,
    });
    const post = vi
      .fn()
      .mockRejectedValueOnce(networkError)
      .mockResolvedValueOnce(
        response(200, '{"project_id":"project-2"}', { project_id: 'project-2' }),
      );

    const result = provisionProject(clientWithPost(post), { name: 'release-gate-test' });

    await expect(settleTimers(result)).resolves.toBe('project-2');
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('does not retry a persistent HTTP 400 response', async () => {
    const post = vi.fn().mockResolvedValue(response(400, '{"error":"invalid request"}'));

    await expect(
      provisionProject(clientWithPost(post), { name: 'release-gate-test' }),
    ).rejects.toThrow('HTTP 400');
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('retries an explicit HTTP 403 rate-limit response', async () => {
    vi.useFakeTimers();
    const post = vi
      .fn()
      .mockResolvedValueOnce(response(403, '{"error":"secondary rate limit"}'))
      .mockResolvedValueOnce(
        response(200, '{"project_id":"project-3"}', { project_id: 'project-3' }),
      );

    const result = provisionProject(clientWithPost(post), { name: 'release-gate-test' });

    await expect(settleTimers(result)).resolves.toBe('project-3');
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('continues polling after a marked network error', async () => {
    vi.useFakeTimers();
    const networkError = Object.assign(new Error('request timed out'), {
      ke2eRetryable: true,
    });
    const read = vi.fn().mockRejectedValueOnce(networkError).mockResolvedValueOnce('ready');

    const result = waitFor(read, {
      until: (value) => value === 'ready',
      timeoutMs: 10_000,
      intervalMs: 1_000,
      retryOnError: isKe2eRetryableError,
    });

    await expect(settleTimers(result)).resolves.toBe('ready');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('fails polling immediately for an unmarked error', async () => {
    const error = new Error('contract failure');
    const read = vi.fn().mockRejectedValue(error);

    await expect(
      waitFor(read, {
        until: () => false,
        timeoutMs: 10_000,
        intervalMs: 1_000,
        retryOnError: () => false,
      }),
    ).rejects.toThrow('contract failure');
    expect(read).toHaveBeenCalledTimes(1);
  });
});
