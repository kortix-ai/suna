/**
 * Transient-status retry for the deployed browser lane.
 *
 * Release gate 32240074477 failed with staging-api answering `503
 * MAINTENANCE_MODE` and the gateway reporting `"status":"degraded"` with an
 * "error rate 51% over 300s" incident. None of the browser helpers retried a
 * 5xx — only a transport throw — so a blip that cleared in seconds surfaced as
 * either an opaque `TypeError: accounts.json.find is not a function`
 * (a 503 body is an object, not the expected array) or an
 * `expect(503).toBe(403)`. Both name the wrong thing.
 *
 * What is retried, and why it is safe:
 *  - Any request whose body says `MAINTENANCE_MODE`. The edge rejects that
 *    request before the origin handler runs, so repeating it cannot duplicate
 *    a write.
 *  - `GET`/`HEAD` on 429/502/503/504. Idempotent by definition.
 * A non-idempotent request that reached the origin (a plain 502/504 on POST)
 * is NOT retried — a duplicate write is worse than a red gate.
 *
 * A status the caller explicitly expects is never retried: `apiJson(…, 403)`
 * asserting a refusal must not sit in a backoff loop.
 */
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function transientRetryBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number.parseInt(env.E2E_TRANSIENT_RETRY_MS ?? '', 10);
  if (Number.isFinite(configured) && configured >= 0) return configured;
  // Only a deployed target shares its origin with the concurrent REST lane and
  // with real traffic. Locally a 5xx is a genuine defect and must fail fast.
  return env.KE2E_TARGET ? 60_000 : 0;
}

export function isTransientStatus(
  method: string,
  status: number,
  body: string,
  expectedStatus: number[] = [],
): boolean {
  if (expectedStatus.includes(status)) return false;
  if (!RETRYABLE_STATUSES.has(status)) return false;
  if (body.includes('MAINTENANCE_MODE')) return true;
  return IDEMPOTENT_METHODS.has(method.toUpperCase());
}

export function transientRetryDelayMs(attempt: number): number {
  return Math.min(1_000 * 2 ** attempt, 8_000);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

interface RawResponse {
  status: number;
  url: string;
  body: string;
}

/**
 * One request, retried past a transient deployed-target status.
 *
 * Returns the LAST response when the budget runs out, so the caller still
 * reports the real status and body — never a synthetic error.
 */
export async function requestWithTransientRetry(
  url: string,
  init: RequestInit,
  expectedStatus: number[] = [],
  budgetMs: number = transientRetryBudgetMs(),
): Promise<RawResponse> {
  const method = (init.method ?? 'GET').toUpperCase();
  const deadline = Date.now() + budgetMs;
  // A transport throw keeps the 3-attempt tolerance `apiResult` always had, so
  // a local run (budget 0) does not lose its connection-reset resilience.
  const minTransportAttempts = 3;
  let attempt = 0;
  for (;;) {
    try {
      const response = await fetch(url, init);
      const body = await response.text();
      const result = { status: response.status, url: response.url || url, body };
      if (!isTransientStatus(method, response.status, body, expectedStatus)) return result;
      if (Date.now() >= deadline) return result;
    } catch (error) {
      if (attempt + 1 >= minTransportAttempts && Date.now() >= deadline) throw error;
    }
    await sleep(transientRetryDelayMs(attempt));
    attempt += 1;
  }
}

export function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

export async function json<T>(
  response: Response,
  expectedStatus: number | number[] = 200,
): Promise<T> {
  const expected = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
  const body = await response.text();
  if (!expected.includes(response.status)) {
    throw new Error(
      `Expected ${expected.join('/')} from ${response.url}, got ${response.status}: ${body}`,
    );
  }
  return body ? JSON.parse(body) as T : ({} as T);
}

export async function apiStatus(
  apiBase: string,
  token: string,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<number> {
  const { status } = await requestWithTransientRetry(`${apiBase}${path}`, {
    method,
    headers: authHeaders(token),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return status;
}

export function createApiStatusClient(apiBase: string) {
  return (
    token: string,
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<number> => apiStatus(apiBase, token, method, path, body);
}

export async function apiJson<T>(
  apiBase: string,
  token: string,
  method: string,
  path: string,
  body?: Record<string, unknown>,
  expectedStatus: number | number[] = 200,
): Promise<T> {
  const expected = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
  const response = await requestWithTransientRetry(
    `${apiBase}${path}`,
    {
      method,
      headers: authHeaders(token),
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    expected,
  );
  if (!expected.includes(response.status)) {
    throw new Error(
      `Expected ${expected.join('/')} from ${response.url}, got ${response.status}: ${response.body}`,
    );
  }
  return response.body ? (JSON.parse(response.body) as T) : ({} as T);
}

export function createApiJsonClient(apiBase: string) {
  return <T>(
    token: string,
    method: string,
    path: string,
    body?: Record<string, unknown>,
    expectedStatus: number | number[] = 200,
  ): Promise<T> => apiJson<T>(apiBase, token, method, path, body, expectedStatus);
}

/**
 * Statuses a shared deployed origin emits for reasons outside the product.
 *
 * `502/503/504` come from the edge, the load balancer, or the maintenance gate
 * — never from an application code path a browser journey is asserting. Release
 * gate 32240074477 ran while staging-api was answering `503 MAINTENANCE_MODE`
 * and the gateway reported `"status":"degraded"`, so every journey with a
 * blanket "no 5xx" assertion failed on the environment rather than on the
 * product.
 *
 * `500` stays a hard failure: that is an unhandled exception in a route, which
 * is exactly the class of defect these journeys exist to catch.
 */
export const INFRASTRUCTURE_STATUSES = new Set([502, 503, 504]);

export function isProductServerError(status: number): boolean {
  return status >= 500 && !INFRASTRUCTURE_STATUSES.has(status);
}

/**
 * Poll one request until it answers the status the caller demands.
 *
 * For assertions that follow a REVOKE. `apps/api/src/iam/cache-invalidation.ts`
 * memoizes authz lookups for ~15s and busts them **process-locally** — its own
 * header says "each API replica busts its own cache". Staging runs several
 * replicas behind one load balancer, so the replica that served the revoke is
 * often not the replica that serves the next read, and the stale POSITIVE entry
 * can answer 200 for up to one TTL window. That is correct product behavior;
 * asserting the refusal in the very next request is what is unsound.
 *
 * The budget is 20s — one TTL window plus margin. Returns the last status seen,
 * so a genuine authz regression still fails with the real status, only later.
 */
export async function pollApiStatus(
  request: () => Promise<number>,
  expected: number,
  { timeoutMs = 20_000, intervalMs = 1_000 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let status = await request();
  while (status !== expected && Date.now() < deadline) {
    await sleep(intervalMs);
    status = await request();
  }
  return status;
}

export async function apiResult<T>(
  apiBase: string,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: T | null }> {
  const response = await requestWithTransientRetry(`${apiBase}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let parsed: T | null = null;
  try {
    parsed = response.body ? (JSON.parse(response.body) as T) : null;
  } catch {
    parsed = null;
  }
  return { status: response.status, json: parsed };
}

export function createApiResultClient(apiBase: string) {
  return <T>(
    token: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: T | null }> => apiResult<T>(apiBase, token, method, path, body);
}
