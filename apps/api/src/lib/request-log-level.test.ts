/**
 * Regressions for the post-request `Request completed:` line:
 *
 * - KRTX-627: the line must not be WARN for a request that succeeded. Before
 *   the fix, a slow success (duration > 5000 ms, status 200) logged at WARN, so
 *   ordinary fleet-wide contention paged as a warn-class log anomaly on the
 *   sessions read route.
 *
 * - KRTX-397: a control-plane 503 (`sandbox_not_ready`, `X-Kortix-Proxy-Hop:
 *   control_plane`) on a proxied GET is the proxy's designed answer for a
 *   sandbox row that is not `active` — it dialled nothing, the row carries the
 *   state, and the client reads the response headers. Logging it counted every
 *   parked-box read burst as route 5xx (about 40 such 503s a day on the
 *   data-path GET routes alone).
 *
 * - KRTX-397 (second half): the daemon's own boot-phase 503
 *   (`runtime_not_ready`, `X-Kortix-Proxy-Hop: daemon`) on a proxied GET is
 *   the designed answer for an opencode runtime that is restarting behind a
 *   live box — the proxy passes it through on purpose (no retry; the client
 *   re-polls) and the box recovers within seconds. Logging it counted the
 *   boot window as route 5xx on every hydrate read
 *   (`/lsp/diagnostics`, `/permission`, `/question`, `/vcs/diff`, …). A 502,
 *   an unattributed passthrough, or a mutation stays logged.
 *
 * - KRTX-468: the line carries the per-stage `Server-Timing` breakdown on the
 *   slow or failed tail. A p95 anomaly used to leave one opaque `duration`;
 *   the breakdown answers "DB stretch or app-side work" from the line itself.
 */
import { describe, expect, test } from 'bun:test';
import { runWithContext } from './request-context';
import {
  requestClientLogFields,
  requestLogLevel,
  requestTimingLogField,
  shouldSuppressRequestLog,
} from './request-log-level';
import { beginStage } from './server-timing';

describe('requestLogLevel', () => {
  test('a successful or client-error request is INFO, however slow', () => {
    expect(requestLogLevel(200)).toBe('info');
    expect(requestLogLevel(201)).toBe('info');
    expect(requestLogLevel(304)).toBe('info');
    expect(requestLogLevel(403)).toBe('info');
    expect(requestLogLevel(404)).toBe('info');
  });

  test('only a server failure is WARN', () => {
    expect(requestLogLevel(500)).toBe('warn');
    expect(requestLogLevel(503)).toBe('warn');
  });
});

describe('shouldSuppressRequestLog', () => {
  // Synthetic path — the shape of any proxied data-path GET.
  const parkedRead = {
    method: 'GET',
    path: '/v1/p/<sandbox>/8000/lsp/diagnostics',
    status: 503,
    durationMs: 8,
    proxyHop: 'control_plane',
    upstreamStatus: null,
  };

  test('a control-plane not-ready 503 on a proxied GET is suppressed (KRTX-397)', () => {
    expect(shouldSuppressRequestLog(parkedRead)).toBe(true);
    // Same shape on the sibling data paths the hydrate burst hits.
    expect(
      shouldSuppressRequestLog({ ...parkedRead, path: '/v1/p/<sandbox>/8000/permission' }),
    ).toBe(true);
    expect(shouldSuppressRequestLog({ ...parkedRead, path: '/v1/p/<sandbox>/8000/question' })).toBe(
      true,
    );
  });

  test('the daemon boot-phase not-ready 503 on a proxied GET is suppressed (KRTX-397)', () => {
    // The proxy passes the daemon's `runtime_not_ready` 503 through on purpose
    // and attributes it `daemon` with the daemon's own 503 as the upstream
    // status — the designed boot-window answer.
    expect(
      shouldSuppressRequestLog({ ...parkedRead, proxyHop: 'daemon', upstreamStatus: 503 }),
    ).toBe(true);
    // Same shape on the sibling data paths the hydrate burst hits.
    expect(
      shouldSuppressRequestLog({
        ...parkedRead,
        path: '/v1/p/<sandbox>/8000/permission',
        proxyHop: 'daemon',
        upstreamStatus: 503,
      }),
    ).toBe(true);
    expect(
      shouldSuppressRequestLog({
        ...parkedRead,
        path: '/v1/p/<sandbox>/8000/vcs/diff',
        proxyHop: 'daemon',
        upstreamStatus: 503,
      }),
    ).toBe(true);
  });

  test('a give-up 502 the edge rewrote to 503 stays logged (KRTX-397)', () => {
    // http-middleware.ts logs every give-up 502 as a 503 with the honest 502
    // in X-Kortix-Upstream-Status. That is an outage signal, not boot noise.
    expect(
      shouldSuppressRequestLog({ ...parkedRead, proxyHop: 'daemon', upstreamStatus: 502 }),
    ).toBe(false);
    // No upstream status at all — every attempt threw; the port never answered.
    expect(
      shouldSuppressRequestLog({ ...parkedRead, proxyHop: 'daemon', upstreamStatus: null }),
    ).toBe(false);
  });

  test('a 503 without the daemon attribution stays logged', () => {
    // No hop header — an upstream passthrough or an edge-rewritten response.
    expect(
      shouldSuppressRequestLog({ ...parkedRead, proxyHop: null, upstreamStatus: 503 }),
    ).toBe(false);
    // A hop the proxy assigns to an app port: a not-ready-SHAPED 503 from a
    // user's own dev server (KRTX-397 self-review) is attributed
    // `upstream_port`, not `daemon`, so its GET line stays logged and the
    // app cannot borrow the daemon's designed answer.
    expect(
      shouldSuppressRequestLog({ ...parkedRead, proxyHop: 'upstream_port', upstreamStatus: 503 }),
    ).toBe(false);
  });

  test('a daemon 502 or a mutation stays logged', () => {
    // A give-up 502 means the port was unreachable for the whole retry ladder.
    expect(
      shouldSuppressRequestLog({ ...parkedRead, status: 502, proxyHop: 'daemon', upstreamStatus: 502 }),
    ).toBe(false);
    // A mutation through the boot window is never noise.
    expect(
      shouldSuppressRequestLog({
        method: 'POST',
        path: '/v1/p/<sandbox>/8000/log',
        status: 503,
        durationMs: 20,
        proxyHop: 'daemon',
        upstreamStatus: 503,
      }),
    ).toBe(false);
  });

  test('a mutation is never suppressed, even from the control plane', () => {
    expect(
      shouldSuppressRequestLog({
        method: 'POST',
        path: '/v1/p/<sandbox>/8000/log',
        status: 503,
        durationMs: 20,
        proxyHop: 'control_plane',
        upstreamStatus: null,
      }),
    ).toBe(false);
  });

  test('long-poll and startup-probe 502/503/504 shapes stay suppressed', () => {
    const longPoll = {
      method: 'GET',
      path: '/v1/p/<sandbox>/8000/global/event',
      status: 503,
      durationMs: 92,
      proxyHop: null,
      upstreamStatus: null,
    };
    expect(shouldSuppressRequestLog(longPoll)).toBe(true);
    expect(shouldSuppressRequestLog({ ...longPoll, status: 504 })).toBe(true);
    expect(
      shouldSuppressRequestLog({
        method: 'GET',
        path: '/v1/p/<sandbox>/8000/kortix/health',
        status: 502,
        durationMs: 311,
        proxyHop: null,
        upstreamStatus: null,
      }),
    ).toBe(true);
  });

  test('a slow successful long-poll is suppressed; a fast one is not', () => {
    const longPoll = {
      method: 'GET',
      path: '/v1/p/<sandbox>/8000/session/<session>/message',
      status: 200,
      durationMs: 6000,
      proxyHop: null,
      upstreamStatus: null,
    };
    expect(shouldSuppressRequestLog(longPoll)).toBe(true);
    expect(shouldSuppressRequestLog({ ...longPoll, durationMs: 400 })).toBe(false);
  });
});

describe('requestTimingLogField', () => {
  test('a fast success carries no stage breakdown', () => {
    expect(requestTimingLogField(30, 200)).toBe('');
    expect(requestTimingLogField(999, 200)).toBe('');
  });

  test('a slow request carries the stage entries it recorded', async () => {
    const line = await runWithContext('GET', '/v1/projects/<project>/sessions', async () => {
      const end = beginStage('db');
      await new Promise((resolve) => setTimeout(resolve, 15));
      end();
      return requestTimingLogField(1_100, 200);
    });

    expect(line).toMatch(/^db;dur=\d+;desc="n=1"$/);
    const duration = /db;dur=(\d+)/.exec(line)?.[1] ?? '0';
    expect(Number(duration)).toBeGreaterThanOrEqual(10);
  });

  test('a 5xx carries the breakdown even when fast', async () => {
    const line = await runWithContext('GET', '/x', async () => {
      const end = beginStage('db');
      end();
      return requestTimingLogField(30, 500);
    });
    expect(line).toContain('db;dur=');
  });

  test('outside a request context it is empty, not a throw', () => {
    expect(requestTimingLogField(1_100, 200)).toBe('');
    expect(requestTimingLogField(30, 500)).toBe('');
  });

  test('KORTIX_SLOW_REQUEST_TIMING_MS moves the slow tail threshold', () => {
    const previous = process.env.KORTIX_SLOW_REQUEST_TIMING_MS;
    process.env.KORTIX_SLOW_REQUEST_TIMING_MS = '1';
    try {
      // No request context: the 1 ms threshold puts the request on the slow
      // tail, and the breakdown of zero stages is an empty string.
      expect(requestTimingLogField(5, 200)).toBe('');
    } finally {
      if (previous === undefined) delete process.env.KORTIX_SLOW_REQUEST_TIMING_MS;
      else process.env.KORTIX_SLOW_REQUEST_TIMING_MS = previous;
    }
  });
});

describe('requestClientLogFields', () => {
  const headers = (map: Record<string, string>) => (name: string) => map[name];

  test('logs the reported surface and version so a route can be retired on data', () => {
    expect(requestClientLogFields(headers({ 'x-kortix-client-version': 'cli/0.13.42-dev.ab12cd3' }))).toEqual({
      client_version: 'cli/0.13.42-dev.ab12cd3',
    });
  });

  test('ignores the retired X-Kortix-Client header', () => {
    expect(requestClientLogFields(headers({ 'x-kortix-client': 'cli' }))).toEqual({});
  });

  test('omits a missing, malformed or credential-shaped value', () => {
    expect(requestClientLogFields(headers({}))).toEqual({});
    expect(requestClientLogFields(headers({ 'x-kortix-client-version': 'a b' }))).toEqual({});
    expect(requestClientLogFields(headers({ 'x-kortix-client-version': 'x'.repeat(65) }))).toEqual({});
    expect(requestClientLogFields(headers({ 'x-kortix-client-version': 'sk-live-123' }))).toEqual({});
  });
});
