/**
 * Regressions for the sandbox-proxy `Request completed:` line suppression
 * (`shouldSuppressRequestLog`), which the inline post-request logger in
 * `http-middleware.ts` applies before logging:
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
 * - KRTX-2277: the same designed boot-phase 503 on the session-abort verb
 *   (`POST /v1/p/:id/:id/session/:id/abort`) — a Stop the client re-presses
 *   until it lands — paged as a route 5xx rise because only GETs were
 *   suppressed. Prod, 2026-10-14: one wedged sandbox produced 22 such 503s
 *   in 40 minutes. Every other mutation stays logged.
 */
import { describe, expect, test } from 'bun:test';
import { shouldSuppressRequestLog } from './request-log-suppression';

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

  test('the daemon boot-phase not-ready 503 on the session-abort verb is suppressed (KRTX-2277)', () => {
    // A Stop pressed while the daemon's opencode restarts is the same designed
    // boot-window answer KRTX-397 suppresses on GETs — the abort is idempotent,
    // carries no data, and the client re-presses until it lands. Prod,
    // 2026-10-14: one wedged sandbox produced 22 such 503s in 40 minutes and
    // the sweep paged them as a route 5xx rise on the abort verb.
    expect(
      shouldSuppressRequestLog({
        method: 'POST',
        path: '/v1/p/<sandbox>/8000/session/<session>/abort',
        status: 503,
        durationMs: 30,
        proxyHop: 'daemon',
        upstreamStatus: 503,
      }),
    ).toBe(true);
    // The in-box nested spelling routes as the same abort call.
    expect(
      shouldSuppressRequestLog({
        method: 'POST',
        path: '/v1/p/<sandbox>/8000/proxy/4096/session/<session>/abort',
        status: 503,
        durationMs: 30,
        proxyHop: 'daemon',
        upstreamStatus: 503,
      }),
    ).toBe(true);
  });

  test('a not-ready 503 on another mutation stays logged (KRTX-2277)', () => {
    // A message that 503s was not delivered — a real failed user action.
    expect(
      shouldSuppressRequestLog({
        method: 'POST',
        path: '/v1/p/<sandbox>/8000/session/<session>/message',
        status: 503,
        durationMs: 30,
        proxyHop: 'daemon',
        upstreamStatus: 503,
      }),
    ).toBe(false);
    // The prompt verb is a turn start, not an abort.
    expect(
      shouldSuppressRequestLog({
        method: 'POST',
        path: '/v1/p/<sandbox>/8000/kortix/runtime/sessions/<session>/prompt',
        status: 503,
        durationMs: 30,
        proxyHop: 'daemon',
        upstreamStatus: 503,
      }),
    ).toBe(false);
    // A path that only CONTAINS the abort shape is not the abort verb: the
    // daemon's own routes are mounted at /kortix/..., and a nested spelling
    // that is not a runtime request stays logged.
    expect(
      shouldSuppressRequestLog({
        method: 'POST',
        path: '/v1/p/<sandbox>/8000/session/<session>/abort/extra',
        status: 503,
        durationMs: 30,
        proxyHop: 'daemon',
        upstreamStatus: 503,
      }),
    ).toBe(false);
  });

  test('a give-up 502 on the abort verb stays logged (KRTX-2277)', () => {
    // The give-up logs at its internal 502 without a hop header — an outage
    // signal, not boot noise.
    expect(
      shouldSuppressRequestLog({
        method: 'POST',
        path: '/v1/p/<sandbox>/8000/session/<session>/abort',
        status: 502,
        durationMs: 5788,
        proxyHop: null,
        upstreamStatus: null,
      }),
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
