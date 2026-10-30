// KRTX-471: the latency shape this issue kept chasing is CONCURRENCY to one
// sandbox — 2026-10-10 one client fired 649 concurrent `/file/raw` reads at a
// single box; 2026-10-16 six concurrent reads to one degraded box carried the
// route's p95 to 5.4 s. The request log could not show that: six rows to one
// sandbox read as six independent slow requests, and the SDK-side limiter
// (PR #9516) only sees the web client, never agents, scripts or mobile.
// `sandbox_inflight` closes that gap: the count of proxied requests in flight
// to the SAME sandbox when this one entered, counted with self, stamped on the
// request log line. A herd is then one query: max(sandbox_inflight) per
// sandbox-minute, not a hand rebuild of overlaps from completion timestamps.
//
// These tests drive the real middleware through a real Hono app. Each request
// runs inside its own request context (production semantics: the request-
// context middleware wraps every HTTP request), and the stamp is read inside
// the downstream handler, because the gate must stamp it before the handler
// runs. Dispatch up to a handler's first await is synchronous in Hono, so
// arrival order equals fire order.

import { Hono } from 'hono';
import { describe, expect, test } from 'bun:test';

const { sandboxInflightGate } = await import('./sandbox-inflight');
const { getDiagnosticFields, runWithContext } = await import('../lib/request-context');

function buildApp() {
  const app = new Hono();
  app.use('/:sandboxId/:port/*', sandboxInflightGate);
  app.use('/:sandboxId/:port', sandboxInflightGate);
  return app;
}

interface Deferred {
  promise: Promise<void>;
  open: () => void;
}

function deferred(): Deferred {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** Fire one proxied GET inside its own request context. */
async function fire(app: Hono, path: string): Promise<Response> {
  return runWithContext('GET', path, () => app.request(path));
}

describe('sandboxInflightGate', () => {
  test('two overlapping requests to one sandbox stamp 1 then 2', async () => {
    const app = buildApp();
    const PATH = '/sbx-1/8000/file/raw';
    const entered = [deferred(), deferred()];
    const releaseAll = deferred();
    let arrivals = 0;
    app.get(PATH, (c) => {
      entered[arrivals++].open();
      return releaseAll.promise.then(() => c.text(getDiagnosticFields().sandbox_inflight ?? ''));
    });

    const req1 = fire(app, PATH);
    await entered[0].promise;
    // Request 1 is still in flight: request 2 must read 2 in flight.
    const req2 = fire(app, PATH);
    await entered[1].promise;

    releaseAll.open();
    const [res1, res2] = await Promise.all([req1, req2]);
    expect(await res1.text()).toBe('1');
    expect(await res2.text()).toBe('2');
  });

  test('the counter drains: a fresh request after the herd stamps 1 again', async () => {
    const app = buildApp();
    const PATH = '/sbx-2/8000/file/raw';
    const releaseAll = deferred();
    app.get(PATH, (c) =>
      releaseAll.promise.then(() => c.text(getDiagnosticFields().sandbox_inflight ?? '')),
    );

    const herd = [fire(app, PATH), fire(app, PATH), fire(app, PATH)];
    releaseAll.open();
    await Promise.all(herd);

    const after = await fire(app, PATH);
    expect(await after.text()).toBe('1');
  });

  test('different sandboxes count independently', async () => {
    const app = buildApp();
    const enteredA = deferred();
    const releaseA = deferred();
    let stampB = '';
    app.get('/:sandboxId/:port/file/raw', async (c) => {
      if (c.req.param('sandboxId') !== 'sbx-a') {
        stampB = getDiagnosticFields().sandbox_inflight ?? '';
        return c.text(stampB);
      }
      enteredA.open();
      await releaseA.promise;
      return c.text('held');
    });

    const held = fire(app, '/sbx-a/8000/file/raw');
    await enteredA.promise;
    const other = await fire(app, '/sbx-b/8000/file/raw');
    expect(await other.text()).toBe('1');
    expect(stampB).toBe('1');
    releaseA.open();
    await held;
  });

  test('a CORS preflight (OPTIONS) never counts and never stamps', async () => {
    const app = buildApp();
    const PATH = '/sbx-3/8000/file/raw';
    const enteredGet = deferred();
    const enteredOptions = deferred();
    const releaseAll = deferred();
    let optionsStamp: string | undefined = 'unread';
    app.get(PATH, (c) => {
      enteredGet.open();
      return releaseAll.promise.then(() => c.text('ok'));
    });
    app.on('OPTIONS', PATH, (c) => {
      optionsStamp = getDiagnosticFields().sandbox_inflight;
      enteredOptions.open();
      return c.text('ok');
    });

    const held = fire(app, PATH);
    await enteredGet.promise;
    // The GET still holds the box: a preflight must not add to the count
    // and must not carry a stamp of its own.
    const preflight = runWithContext('OPTIONS', PATH, () =>
      app.request(PATH, { method: 'OPTIONS' }),
    );
    await enteredOptions.promise;
    expect(optionsStamp).toBeUndefined();
    releaseAll.open();
    expect((await held).status).toBe(200);
    expect((await preflight).status).toBe(200);
  });

  test('a handler error still drains the counter', async () => {
    const app = buildApp();
    app.get('/:sandboxId/:port/file/raw', () => {
      throw new Error('boom');
    });
    app.get('/:sandboxId/:port/alive', (c) =>
      c.text(getDiagnosticFields().sandbox_inflight ?? ''),
    );
    await fire(app, '/sbx-4/8000/file/raw');

    const res = await fire(app, '/sbx-4/8000/alive');
    expect(await res.text()).toBe('1');
  });
});
