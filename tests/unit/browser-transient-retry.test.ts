import { describe, expect, it } from 'vitest';

import {
  isProductServerError,
  isTransientStatus,
  pollApiStatus,
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
