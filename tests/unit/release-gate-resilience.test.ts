import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Client,
  Res,
  isKe2eRetryableError,
  isKe2eTransientGatewayResponse,
  ke2eRetryDelayMs,
} from '../src/core/client';
import { waitFor } from '../src/core/poll';
import type { Captured } from '../src/core/result';

let paceProvisionRequest: typeof import('../src/fixtures/provision').paceProvisionRequest;
let provisionProject: typeof import('../src/fixtures/provision').provisionProject;

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

function capturedResponse(status: number, headers: Record<string, string>): Res {
  const captured: Captured = {
    routeTemplate: 'GET /v1/test',
    req: { method: 'GET', url: 'https://example.test/v1/test', headers: {} },
    res: { status, headers, bodyText: '' },
    ms: 1,
  };
  return new Res(captured);
}

describe('release gate transient failure resilience', () => {
  beforeEach(async () => {
    vi.stubEnv('KE2E_PROVISION_CONCURRENCY', '2');
    vi.stubEnv('KE2E_PROVISION_MIN_INTERVAL_MS', '0');
    vi.stubEnv('KE2E_PROVISION_RATE_LIMIT_DELAY_MS', '120000');
    vi.resetModules();
    ({ paceProvisionRequest, provisionProject } = await import('../src/fixtures/provision'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
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
    const attempts: number[] = [];
    const post = vi
      .fn()
      .mockImplementationOnce(async () => {
        attempts.push(Date.now());
        return response(403, '{"error":"secondary rate limit"}');
      })
      .mockImplementationOnce(async () => {
        attempts.push(Date.now());
        return response(200, '{"project_id":"project-3"}', { project_id: 'project-3' });
      });

    const result = provisionProject(clientWithPost(post), { name: 'release-gate-test' });

    await expect(settleTimers(result)).resolves.toBe('project-3');
    expect(post).toHaveBeenCalledTimes(2);
    expect(attempts).toHaveLength(2);
    expect((attempts.at(1) ?? 0) - (attempts.at(0) ?? 0)).toBeGreaterThanOrEqual(120_000);
  });

  it('paces concurrent managed repository creation attempts', async () => {
    vi.useFakeTimers();
    const starts: number[] = [];

    const first = paceProvisionRequest(5_000).then(() => starts.push(Date.now()));
    const second = paceProvisionRequest(5_000).then(() => starts.push(Date.now()));

    await settleTimers(Promise.all([first, second]));
    expect(starts).toHaveLength(2);
    expect((starts.at(1) ?? 0) - (starts.at(0) ?? 0)).toBeGreaterThanOrEqual(5_000);
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

  it('identifies only host-level gateway failures as transient', () => {
    expect(
      isKe2eTransientGatewayResponse(
        capturedResponse(502, {
          'content-type': 'text/html; charset=UTF-8',
          'retry-after': '60',
        }),
      ),
    ).toBe(true);
    expect(
      isKe2eTransientGatewayResponse(
        capturedResponse(502, {
          'content-type': 'application/json',
          'x-request-id': 'request-1',
        }),
      ),
    ).toBe(false);
    expect(
      isKe2eTransientGatewayResponse(
        capturedResponse(400, {
          'content-type': 'application/json',
        }),
      ),
    ).toBe(false);
  });

  it('marks an unexpected host-level gateway status for a clean flow retry', () => {
    const response = capturedResponse(503, {
      'content-type': 'application/json',
      'retry-after': '30',
      'x-maintenance-mode': 'blocking',
    });

    let error: unknown;
    try {
      response.status(200);
    } catch (caught) {
      error = caught;
    }

    expect(isKe2eRetryableError(error)).toBe(true);
    expect(ke2eRetryDelayMs(error)).toBe(30_000);
  });

  it('caps a host-requested retry delay at 60 seconds', () => {
    const error = Object.assign(new Error('transient gateway status 503'), {
      ke2eRetryable: true,
      ke2eRetryAfterMs: 180_000,
    });

    expect(ke2eRetryDelayMs(error)).toBe(60_000);
  });

  it('does not mark an API contract 503 for retry', () => {
    const response = capturedResponse(503, {
      'content-type': 'application/json',
      'x-request-id': 'request-1',
    });

    let error: unknown;
    try {
      response.status(200);
    } catch (caught) {
      error = caught;
    }

    expect(isKe2eRetryableError(error)).toBe(false);
  });

  it('retries an opted-in host-level 502 response', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('<html>Bad gateway</html>', {
          status: 502,
          headers: {
            'content-type': 'text/html; charset=UTF-8',
            'retry-after': '60',
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response('{"error":"already stopped"}', {
          status: 409,
          headers: {
            'content-type': 'application/json',
            'x-request-id': 'request-2',
          },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = new Client('https://example.test/v1')
      .withTransientGatewayRetries()
      .get('/v1/test');

    await expect(settleTimers(result)).resolves.toMatchObject({ statusCode: 409 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
