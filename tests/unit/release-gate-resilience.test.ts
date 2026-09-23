import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Client,
  Res,
  isKe2eRetryableError,
  isKe2eTransientGatewayResponse,
  ke2eRetryDelayMs,
  transientBreaker,
} from '../src/core/client';
import { DEFAULT_FLOW_ATTEMPTS } from '../src/core/flow';
import { waitFor } from '../src/core/poll';
import type { Captured } from '../src/core/result';

let paceProvisionRequest: typeof import('../src/fixtures/provision').paceProvisionRequest;
let provisionProject: typeof import('../src/fixtures/provision').provisionProject;

function response(
  statusCode: number,
  bodyText: string,
  json?: unknown,
  headers: Record<string, string> = {},
) {
  return {
    statusCode,
    text: () => bodyText,
    json: <T>() => json as T,
    header: (name: string) => headers[name.toLowerCase()],
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
  it('allows three attempts for transient flow failures by default', () => {
    expect(DEFAULT_FLOW_ATTEMPTS).toBe(3);
  });

  beforeEach(async () => {
    vi.stubEnv('KE2E_PROVISION_CONCURRENCY', '2');
    vi.stubEnv('KE2E_PROVISION_MIN_INTERVAL_MS', '0');
    vi.stubEnv('KE2E_PROVISION_RATE_LIMIT_DELAY_MS', '120000');
    // The transient breaker is process-wide: keep it out of these assertions.
    transientBreaker.reset();
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
    // P1.5: the first rate-limited retry is exponential-with-equal-jitter from
    // a 15s base, not a flat 120s. 120s is now only the CEILING (attempt 4+).
    // The exact schedule is asserted in provisioning-perf.test.ts.
    const delay = (attempts.at(1) ?? 0) - (attempts.at(0) ?? 0);
    expect(delay).toBeGreaterThanOrEqual(7_500);
    expect(delay).toBeLessThanOrEqual(15_000);
  });

  // GitHub's secondary rate limit on repository creation blocks for minutes,
  // not seconds (preview runs 35713379676 and 35715183384, 2026-09-22: every
  // provision 403'd for > 4 min). The API now passes GitHub's wait through as
  // `503` + `Retry-After`; the fixture must honor it, share it across
  // concurrent provisions, and budget rate-limit waits by time, not by a
  // 5-attempt count.
  it('honors Retry-After on a rate-limited 503 instead of the short backoff', async () => {
    vi.useFakeTimers();
    const attempts: number[] = [];
    const post = vi
      .fn()
      .mockImplementationOnce(async () => {
        attempts.push(Date.now());
        return response(
          503,
          '{"error":"GitHub /orgs/o/repos failed (403): You have exceeded a secondary rate limit","code":"GITHUB_RATE_LIMITED","retry_after_seconds":90}',
          undefined,
          { 'retry-after': '90' },
        );
      })
      .mockImplementationOnce(async () => {
        attempts.push(Date.now());
        return response(200, '{"project_id":"project-4"}', { project_id: 'project-4' });
      });

    const result = provisionProject(clientWithPost(post), { name: 'release-gate-test' });

    await expect(settleTimers(result)).resolves.toBe('project-4');
    const delay = (attempts.at(1) ?? 0) - (attempts.at(0) ?? 0);
    expect(delay).toBeGreaterThanOrEqual(90_000);
    expect(delay).toBeLessThanOrEqual(90_000 + 15_000);
  });

  it('holds every concurrent provision behind one rate-limit cooldown', async () => {
    vi.useFakeTimers();
    const started = Date.now();
    const calls: Array<{ name: string; at: number }> = [];
    let first = true;
    const post = vi.fn().mockImplementation(async (_path: string, body: { name: string }) => {
      calls.push({ name: body.name, at: Date.now() - started });
      if (first) {
        first = false;
        return response(503, '{"error":"secondary rate limit","code":"GITHUB_RATE_LIMITED"}', undefined, {
          'retry-after': '60',
        });
      }
      return response(200, `{"project_id":"${body.name}"}`, { project_id: body.name });
    });

    const a = provisionProject(clientWithPost(post), { name: 'a' });
    // B starts after A was refused: it must wait out A's cooldown, not fire.
    await vi.advanceTimersByTimeAsync(1_000);
    const b = provisionProject(clientWithPost(post), { name: 'b' });

    await expect(settleTimers(Promise.all([a, b]))).resolves.toEqual(['a', 'b']);
    const bCall = calls.find((call) => call.name === 'b');
    expect(bCall?.at).toBeGreaterThanOrEqual(60_000);
  });

  it('keeps retrying a rate limit past five attempts while the time budget lasts', async () => {
    vi.useFakeTimers();
    const limited = () =>
      response(503, '{"error":"secondary rate limit","code":"GITHUB_RATE_LIMITED"}', undefined, {
        'retry-after': '60',
      });
    const post = vi.fn();
    for (let i = 0; i < 6; i++) post.mockResolvedValueOnce(limited());
    post.mockResolvedValueOnce(response(200, '{"project_id":"project-5"}', { project_id: 'project-5' }));

    const result = provisionProject(clientWithPost(post), { name: 'release-gate-test' });

    await expect(settleTimers(result)).resolves.toBe('project-5');
    expect(post).toHaveBeenCalledTimes(7);
  });

  it('gives up on a rate limit once the time budget is spent, with the real reason', async () => {
    vi.useFakeTimers();
    const post = vi.fn().mockResolvedValue(
      response(503, '{"error":"secondary rate limit","code":"GITHUB_RATE_LIMITED"}', undefined, {
        'retry-after': '300',
      }),
    );

    const result = provisionProject(clientWithPost(post), { name: 'release-gate-test' });
    const settled = result.then(() => null, (error: unknown) => error);

    const error = await settleTimers(settled);
    expect(String(error)).toMatch(/HTTP 503.*secondary rate limit/);
    // 15 min budget / 300 s waits: bounded, never endless.
    expect(post.mock.calls.length).toBeLessThanOrEqual(5);
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
    expect(ke2eRetryDelayMs(error)).toBe(15_000);
  });

  it('caps a host-requested retry delay at 15 seconds', () => {
    const error = Object.assign(new Error('transient gateway status 503'), {
      ke2eRetryable: true,
      ke2eRetryAfterMs: 180_000,
    });

    expect(ke2eRetryDelayMs(error)).toBe(15_000);
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
