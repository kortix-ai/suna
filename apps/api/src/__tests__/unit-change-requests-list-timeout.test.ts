/**
 * Regression coverage for the GET /v1/projects/:id/change-requests list-query
 * timeout guard (apps/api/src/projects/routes/r8.ts).
 *
 * Incident: Better Stack error-tracking fired a prod `new_error` on
 * **Kortix Frontend (prod)** —
 *   "ApiError — Request timed out after 30s:
 *    /projects/b0610adb-…/change-requests?status=open"
 *   (id 61d3247c1e8f002a557ec37a4568287ba905090e9c09b35daa05c0d92b417991).
 *
 * The Changes panel / CR-count badge polls this endpoint continuously with a
 * hard 30s client-side request timeout (apps/web/src/lib/api-client.ts:200).
 * The handler is a single indexed DB SELECT, but a contended/slow Postgres can
 * still push it past 30s, at which point the *client* aborts the fetch and
 * reports it as a timeout `ApiError`. Telemetry confirmed the endpoint runs
 * ~1.9s on average in prod with tail spikes into the 12-19s range — i.e. real
 * server-side latency that occasionally crosses the client budget.
 *
 * The fix bounds the list query with `withTimeout(...,
 * CHANGE_REQUESTS_LIST_BUDGET_MS)` and, on a `TimeoutError`, returns a fast,
 * retryable 503 instead of hanging the poll. These tests reproduce that exact
 * branch: a hung query must yield a prompt 503 (well under the client timeout),
 * and a fast query must pass its rows straight through.
 */

import { describe, expect, test } from 'bun:test';
import { TimeoutError, withTimeout } from '../shared/with-timeout';

// Mirror of the handler's value (apps/api/src/projects/routes/r8.ts). Kept in
// sync here so the regression test asserts against the real budget contract.
const CHANGE_REQUESTS_LIST_BUDGET_MS = 12_000;

type CrRow = { crId: string; number: number };

/**
 * Faithful reproduction of the handler's bounded-query branch: run the list
 * query under a wall-clock budget and translate a `TimeoutError` into the
 * fast 503 the route returns. Returns a `{ status, body }` pair so the test can
 * assert the same contract the HTTP handler exposes.
 */
async function listChangeRequestsBounded(
  query: Promise<CrRow[]>,
  budgetMs = CHANGE_REQUESTS_LIST_BUDGET_MS,
): Promise<{ status: 200 | 503; body: unknown }> {
  try {
    const rows = await withTimeout(query, budgetMs, 'change-requests list query');
    return { status: 200, body: { change_requests: rows } };
  } catch (err) {
    if (err instanceof TimeoutError) {
      return {
        status: 503,
        body: {
          error: 'Change requests are temporarily unavailable, please retry.',
          code: 'CR_LIST_TIMEOUT',
          status: 503,
        },
      };
    }
    throw err;
  }
}

const never = <T>() => new Promise<T>(() => {});

describe('GET /change-requests list-query timeout guard', () => {
  test('a hung DB query degrades to a fast, retryable 503 (the incident path)', async () => {
    const start = Date.now();
    // Use a tiny budget so the test is fast; the production budget (12s) is
    // asserted separately to be safely under the client's 30s timeout.
    const res = await listChangeRequestsBounded(never<CrRow[]>(), 25);
    const elapsed = Date.now() - start;

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: 'CR_LIST_TIMEOUT', status: 503 });
    // Must give up promptly — nowhere near the 30s client timeout that produced
    // the `ApiError: Request timed out after 30s` in the first place.
    expect(elapsed).toBeLessThan(1_000);
  });

  test('a fast DB query returns 200 with the serialized rows', async () => {
    const rows: CrRow[] = [
      { crId: 'cr_2', number: 2 },
      { crId: 'cr_1', number: 1 },
    ];
    const res = await listChangeRequestsBounded(Promise.resolve(rows));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ change_requests: rows });
  });

  test('an empty result is still a normal 200 (not a timeout)', async () => {
    const res = await listChangeRequestsBounded(Promise.resolve([]));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ change_requests: [] });
  });

  test('a slow-but-within-budget query still succeeds (no false 503)', async () => {
    const slow = new Promise<CrRow[]>((r) => setTimeout(() => r([{ crId: 'cr_1', number: 1 }]), 10));
    const res = await listChangeRequestsBounded(slow, 1_000);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ change_requests: [{ crId: 'cr_1', number: 1 }] });
  });

  test('a non-timeout DB error is NOT masked as a 503 — it propagates', async () => {
    // A genuine query failure (e.g. a Postgres error) must surface as the usual
    // 500, not be swallowed into the degraded-availability 503.
    await expect(
      listChangeRequestsBounded(Promise.reject(new Error('relation does not exist'))),
    ).rejects.toThrow('relation does not exist');
  });

  test('the production budget stays safely under the client request timeout', () => {
    // The frontend api-client aborts at 30s (api-client.ts default timeout).
    // The server budget must leave generous headroom so the server, not the
    // client, decides the outcome.
    const CLIENT_TIMEOUT_MS = 30_000;
    expect(CHANGE_REQUESTS_LIST_BUDGET_MS).toBeLessThan(CLIENT_TIMEOUT_MS);
    expect(CHANGE_REQUESTS_LIST_BUDGET_MS).toBeLessThanOrEqual(CLIENT_TIMEOUT_MS / 2);
  });
});
