import { describe, expect, it, vi } from 'vitest';

import {
  isProductServerError,
  isTransientStatus,
  pollApiStatus,
  requestWithTransientRetry,
  transientRetryBudgetMs,
  transientRetryDelayMs,
} from '../e2e/helpers/http';

describe('deployed-target transient statuses', () => {
  it('retries any request the maintenance gate rejected', () => {
    // The edge refuses before the origin handler runs, so repeating a POST
    // cannot duplicate a write.
    expect(isTransientStatus('POST', 503, '{"error":"MAINTENANCE_MODE"}')).toBe(true);
    expect(isTransientStatus('DELETE', 503, '{"error":"MAINTENANCE_MODE"}')).toBe(true);
  });

  it('retries an idempotent request on a plain edge failure', () => {
    expect(isTransientStatus('GET', 502, 'bad gateway')).toBe(true);
    expect(isTransientStatus('GET', 504, '')).toBe(true);
    expect(isTransientStatus('GET', 429, '')).toBe(true);
  });

  it('never repeats a non-idempotent request that reached the origin', () => {
    // A duplicated write is worse than a red gate.
    expect(isTransientStatus('POST', 502, 'bad gateway')).toBe(false);
    expect(isTransientStatus('PATCH', 504, '')).toBe(false);
  });

  it('leaves a real product status alone', () => {
    expect(isTransientStatus('GET', 403, '')).toBe(false);
    expect(isTransientStatus('GET', 500, 'boom')).toBe(false);
    expect(isTransientStatus('GET', 200, '[]')).toBe(false);
  });

  it('never retries a status the caller explicitly expects', () => {
    // `apiJson(…, 503)` asserting a maintenance response must not sit in a
    // backoff loop.
    expect(isTransientStatus('GET', 503, 'MAINTENANCE_MODE', [503])).toBe(false);
  });

  it('spends a retry budget only against a deployed target', () => {
    expect(transientRetryBudgetMs({ KE2E_TARGET: 'staging' })).toBe(60_000);
    // Locally a 5xx is a genuine defect and must fail fast.
    expect(transientRetryBudgetMs({})).toBe(0);
    expect(transientRetryBudgetMs({ KE2E_TARGET: 'staging', E2E_TRANSIENT_RETRY_MS: '5000' })).toBe(
      5_000,
    );
    expect(transientRetryBudgetMs({ KE2E_TARGET: 'staging', E2E_TRANSIENT_RETRY_MS: '0' })).toBe(0);
  });

  it('backs off exponentially and caps the delay', () => {
    expect(transientRetryDelayMs(0)).toBe(1_000);
    expect(transientRetryDelayMs(1)).toBe(2_000);
    expect(transientRetryDelayMs(3)).toBe(8_000);
    expect(transientRetryDelayMs(9)).toBe(8_000);
  });
});

describe('product versus infrastructure server errors', () => {
  it('treats 500 as a defect the journey must catch', () => {
    expect(isProductServerError(500)).toBe(true);
  });

  it('treats an edge failure as environment, not product', () => {
    expect(isProductServerError(502)).toBe(false);
    expect(isProductServerError(503)).toBe(false);
    expect(isProductServerError(504)).toBe(false);
  });

  it('ignores anything below 500', () => {
    expect(isProductServerError(403)).toBe(false);
    expect(isProductServerError(200)).toBe(false);
  });
});

describe('polling a revoke past the IAM cache window', () => {
  it('returns as soon as the expected status appears', async () => {
    const statuses = [200, 200, 403];
    let calls = 0;
    const result = await pollApiStatus(
      async () => statuses[calls++] ?? 403,
      403,
      { timeoutMs: 5_000, intervalMs: 1 },
    );
    expect(result).toBe(403);
    expect(calls).toBe(3);
  });

  it('reports the real status when the budget runs out', async () => {
    // A genuine authz regression must still fail — only later.
    const result = await pollApiStatus(async () => 200, 403, { timeoutMs: 10, intervalMs: 1 });
    expect(result).toBe(200);
  });
});

describe('GitHub rate limit on managed repository creation', () => {
  // The API answers `503 GITHUB_RATE_LIMITED` + `Retry-After` when GitHub's
  // secondary rate limit refuses repository creation. It returns BEFORE the
  // project row exists, so repeating the POST cannot duplicate a write.
  it('treats a GITHUB_RATE_LIMITED POST as transient', () => {
    expect(isTransientStatus('POST', 503, '{"code":"GITHUB_RATE_LIMITED"}')).toBe(true);
    // A plain 503 POST that reached the origin is still never repeated.
    expect(isTransientStatus('POST', 503, '{"error":"boom"}')).toBe(false);
  });

  it('waits the server Retry-After, then succeeds, within the rate-limit budget', async () => {
    vi.useFakeTimers();
    const calls: number[] = [];
    const responses = [
      new Response('{"error":"secondary rate limit","code":"GITHUB_RATE_LIMITED"}', {
        status: 503,
        headers: { 'retry-after': '90' },
      }),
      new Response('{"project_id":"p"}', { status: 201 }),
    ];
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls.push(Date.now());
      return responses.shift()!;
    }));
    // The ordinary transient budget is 60 s; a GitHub block outlasts it.
    const pending = requestWithTransientRetry('https://x.test/v1/projects/provision', { method: 'POST' }, [], 60_000);
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.status).toBe(201);
    expect(calls[1]! - calls[0]!).toBeGreaterThanOrEqual(90_000);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('never waits on a rate limit locally (budget 0)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('{"code":"GITHUB_RATE_LIMITED"}', { status: 503, headers: { 'retry-after': '90' } })));
    const result = await requestWithTransientRetry('https://x.test/v1/projects/provision', { method: 'POST' }, [], 0);
    expect(result.status).toBe(503);
    vi.unstubAllGlobals();
  });
});
