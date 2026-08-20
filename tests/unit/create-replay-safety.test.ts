/**
 * A create is never replayed after an edge-laundered 5xx.
 *
 * Release-gate run 32306385663 lost SEVEN flows to one bug: the Cloudflare
 * worker launders an origin TIMEOUT into a synthetic MAINTENANCE_MODE 503, but
 * the origin has already COMMITTED the write. The ke2e client re-sent the POST,
 * and the second send collided with the row the first send had created —
 * `409 A trigger with slug "nightly" already exists` (TRG-2, TOK-5, TRG-14,
 * CLI-TRG), `409 a role with this key already exists` (TRG-10, IAM-26),
 * `409 Already a member` (MEM-7). Every one of those flows had provisioned a
 * brand-new project or team milliseconds earlier, so nothing but the client's
 * own retry could have owned that name.
 *
 * These tests pin the three parts of the fix:
 *   1. POST is sent exactly once; GET/PUT/DELETE keep the in-request retry.
 *   2. A body-only read of a laundered response raises a RETRYABLE error, so
 *      the flow-level budget re-runs it (IAM-22 died as `fatal` on 1 attempt).
 *   3. A flow retry derives DIFFERENT names than the attempt that failed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Client,
  Res,
  isKe2eRetryableError,
  isReplaySafeMethod,
  throwIfEdgeLaundered,
  transientBreaker,
} from '../src/core/client';
import { attemptSuffix } from '../src/fixtures/world';
import {
  isCliEdgeMaintenanceFailure,
  isCliProcessKilled,
  throwIfCliInfraFailure,
  type CliResult,
} from '../src/fixtures/cli';
import type { Captured } from '../src/core/result';

/** The exact response shape captured from staging in run 32306385663. */
function launderedMaintenance503(): Response {
  return new Response(
    JSON.stringify({
      error: 'MAINTENANCE_MODE',
      message: 'Kortix is temporarily unavailable. Service will resume automatically.',
    }),
    {
      status: 503,
      headers: {
        'content-type': 'application/json',
        'retry-after': '30',
        'x-maintenance-mode': 'blocking',
        // NO x-request-id — that absence is what marks it edge-laundered.
      },
    },
  );
}

function capturedLaundered(): Res {
  const captured: Captured = {
    routeTemplate: 'POST /v1/accounts',
    req: { method: 'POST', url: 'https://example.test/v1/accounts', headers: {} },
    res: {
      status: 503,
      headers: {
        'content-type': 'application/json',
        'retry-after': '30',
        'x-maintenance-mode': 'blocking',
      },
      bodyText: '{"error":"MAINTENANCE_MODE"}',
    },
    ms: 1,
  };
  return new Res(captured);
}

beforeEach(() => {
  transientBreaker.reset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  transientBreaker.reset();
});

describe('replay safety: a create is never re-sent (run 32306385663 Class A)', () => {
  it('classifies only the methods that cannot duplicate a create as replay-safe', () => {
    expect(isReplaySafeMethod('GET')).toBe(true);
    expect(isReplaySafeMethod('head')).toBe(true);
    expect(isReplaySafeMethod('PUT')).toBe(true);
    expect(isReplaySafeMethod('DELETE')).toBe(true);
    // PATCH addresses an existing resource by id — it cannot mint a second row.
    expect(isReplaySafeMethod('PATCH')).toBe(true);
    // POST is the ONLY create verb, and therefore the only exclusion.
    expect(isReplaySafeMethod('POST')).toBe(false);
    expect(isReplaySafeMethod('post')).toBe(false);
  });

  it('sends a POST exactly ONCE through a laundered 503 — no second create', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(async () => launderedMaintenance503());
    vi.stubGlobal('fetch', fetchMock);

    const promise = new Client('https://example.test/v1')
      .withTransientGatewayRetries(3)
      .post('/v1/projects/:projectId/triggers', { name: 'Nightly' });
    await vi.runAllTimersAsync();
    const response = await promise;

    // THE regression guard. Before the fix this was 4 — and sends 2..4 are what
    // produced `409 already exists` against send 1's committed row.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBe(503);
  });

  it('still retries a GET through the same laundered 503', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(async () => launderedMaintenance503());
    vi.stubGlobal('fetch', fetchMock);

    const promise = new Client('https://example.test/v1')
      .withTransientGatewayRetries(3)
      .get('/v1/projects/:projectId/triggers');
    await vi.runAllTimersAsync();
    await promise;

    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('still retries an idempotent PUT and DELETE', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(async () => launderedMaintenance503());
    vi.stubGlobal('fetch', fetchMock);

    const client = new Client('https://example.test/v1').withTransientGatewayRetries(1);
    const put = client.put('/v1/projects/:projectId/access/:userId', { role: 'manager' });
    await vi.runAllTimersAsync();
    await put;
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockClear();
    const del = client.del('/v1/projects/:projectId');
    await vi.runAllTimersAsync();
    await del;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not re-send a POST after a NETWORK error either', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    vi.stubGlobal('fetch', fetchMock);

    const settled = new Client('https://example.test/v1')
      .withTransientGatewayRetries(3)
      .post('/v1/accounts', { name: 'team' })
      .catch((err) => err as Error);
    await vi.runAllTimersAsync();
    const error = await settled;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // One send, but still retryable — the FLOW re-runs it with fresh fixtures.
    expect(isKe2eRetryableError(error)).toBe(true);
  });

  it('hands the un-replayed POST back as a RETRYABLE error, not a hard failure', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => launderedMaintenance503()));

    const promise = new Client('https://example.test/v1').post('/v1/accounts', { name: 'team' });
    await vi.runAllTimersAsync();
    const response = await promise;

    let error: unknown;
    try {
      response.status(201);
    } catch (caught) {
      error = caught;
    }
    // This is what routes the failure to the flow-level infra budget instead of
    // failing the flow on its first attempt.
    expect(isKe2eRetryableError(error)).toBe(true);
    expect((error as Error).message).toContain('edge-laundered');
  });
});

describe('body-only reads of a laundered response (run 32306385663 Class B / IAM-22)', () => {
  it('raises a retryable error before the caller can misread the body', () => {
    let error: unknown;
    try {
      throwIfEdgeLaundered(capturedLaundered(), 'team account create');
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect(isKe2eRetryableError(error)).toBe(true);
    expect((error as Error).message).toContain('team account create');
    expect((error as Error).message).toContain('edge-laundered');
    expect((error as Error).message).toContain('x-request-id=absent');
  });

  it('is a no-op for a genuine application 5xx (it carries x-request-id)', () => {
    const captured: Captured = {
      routeTemplate: 'POST /v1/accounts',
      req: { method: 'POST', url: 'https://example.test/v1/accounts', headers: {} },
      res: {
        status: 503,
        headers: { 'content-type': 'application/json', 'x-request-id': 'req-1' },
        bodyText: '{"error":"boom"}',
      },
      ms: 1,
    };
    // A real API 5xx must still fail the flow — never retried, never excused.
    expect(() => throwIfEdgeLaundered(new Res(captured), 'team account create')).not.toThrow();
  });

  it('is a no-op for a success', () => {
    const captured: Captured = {
      routeTemplate: 'POST /v1/accounts',
      req: { method: 'POST', url: 'https://example.test/v1/accounts', headers: {} },
      res: { status: 201, headers: {}, bodyText: '{"account_id":"a"}' },
      ms: 1,
    };
    expect(() => throwIfEdgeLaundered(new Res(captured), 'team account create')).not.toThrow();
  });
});

describe('CLI infrastructure failures (run 32306385663 Class B / CLI-SESS, CR-9, CLI-SEC)', () => {
  const result = (exitCode: number, all: string): CliResult => ({
    exitCode,
    stdout: '',
    stderr: all,
    all,
  });

  it('marks the CLI rendering of the edge maintenance 503 retryable', () => {
    // Verbatim from CLI-SESS's recorded output.
    const cli = result(
      1,
      '\nhost cloud (https://staging-api.kortix.com, e2e-…@ke2e.kortix.test (user))\n' +
        '  ✗  HTTP 503: Kortix is temporarily unavailable. Service will resume automatically.\n',
    );
    expect(isCliEdgeMaintenanceFailure(cli)).toBe(true);

    let error: unknown;
    try {
      throwIfCliInfraFailure(cli, 'kortix sessions new');
    } catch (caught) {
      error = caught;
    }
    expect(isKe2eRetryableError(error)).toBe(true);
    expect((error as Error).message).toContain('kortix sessions new');
    expect((error as Error).message).toContain('infrastructure, not on contract');
  });

  it('marks a killed process (exit 143) retryable and names the budget', () => {
    // CLI-SEC: `kortix secrets ls after env push exited 143`.
    const cli = result(143, 'host cloud (https://staging-api.kortix.com, …)\n');
    expect(isCliProcessKilled(cli)).toBe(true);

    let error: unknown;
    try {
      throwIfCliInfraFailure(cli, 'kortix secrets ls after env push');
    } catch (caught) {
      error = caught;
    }
    expect(isKe2eRetryableError(error)).toBe(true);
    expect((error as Error).message).toContain('process budget');
  });

  it('leaves a genuine CLI contract failure alone', () => {
    const cli = result(1, "error: unknown flag '--nope'");
    expect(isCliEdgeMaintenanceFailure(cli)).toBe(false);
    expect(isCliProcessKilled(cli)).toBe(false);
    expect(() => throwIfCliInfraFailure(cli, 'kortix sessions new')).not.toThrow();
  });

  it('leaves a successful invocation alone even if its output mentions a 503', () => {
    const cli = result(0, 'last incident: HTTP 503 (resolved)');
    expect(() => throwIfCliInfraFailure(cli, 'kortix sessions ls')).not.toThrow();
  });
});

describe('per-attempt name scoping (run 32306385663 Class A, self-collision)', () => {
  it('leaves attempt 1 byte-identical and renames only a retry', () => {
    expect(attemptSuffix(1)).toBe('');
    expect(attemptSuffix(2)).toBe('-r2');
    expect(attemptSuffix(3)).toBe('-r3');
  });

  it('keeps every derived name inside the e2e- prefix the gc sweep matches', () => {
    const name = (slug: string, attempt: number) => `e2e-run1-${slug}${attemptSuffix(attempt)}`;
    expect(name('mem7-existing', 1)).toBe('e2e-run1-mem7-existing');
    expect(name('mem7-existing', 2)).toBe('e2e-run1-mem7-existing-r2');
    expect(name('mem7-existing', 2).startsWith('e2e-')).toBe(true);
    // Stable WITHIN an attempt: a create and its later read must agree.
    expect(name('hook', 2)).toBe(name('hook', 2));
    // Distinct ACROSS attempts: a retry cannot collide with its predecessor.
    expect(name('hook', 1)).not.toBe(name('hook', 2));
  });
});
