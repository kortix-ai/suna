/**
 * Characterization pin for the index.ts module split (KRTX-347).
 *
 * Written BEFORE the split, against the unsplit file. It pins the observable
 * behavior of the entry module — the route table, the health/readiness/metrics
 * shapes, the installed onError handler (HTTPException, a transient
 * GitOperationError, an unexpected Error) and the Bun.serve edge (idleTimeout,
 * per-request stream timeouts, the WS-readiness 503s) — so the split that
 * moves the code into app.ts / http-middleware.ts / http-errors.ts /
 * routes/* / bootstrap.ts / inbound-dispatch.ts cannot change it.
 */
import { describe, expect, test } from 'bun:test';
import { HTTPException } from 'hono/http-exception';
import { GitOperationError } from '../services/git/mirror';

// The unit-test contract (scripts/test.env, tests/src/core/local-stack.ts):
// tests use the bundled model catalog and never contact models.dev. Setting
// the two switches here also removes index.ts's top-level
// `await initModelPricing()` — under bun test a suspended module hands out its
// namespace early, and the later `export default` would stay unreachable.
// The dynamic import settles the whole module before the tests run.
process.env.KORTIX_MODEL_PRICING_LIVE_ENABLED = '0';
process.env.KORTIX_MODEL_CATALOG_LIVE_ENABLED = '0';
const { default: server, app } = await import('../app/index');

const url = (path: string) => `http://localhost:${server.port}${path}`;
const edge = {
  timeout(_req: Request, seconds: number) {
    edgeCalls.push(seconds);
  },
  upgrade: () => false,
} as any;
const edgeCalls: number[] = [];

describe('API entrypoint characterization', () => {
  test('health, readiness and the route table are mounted once', async () => {
    const routes = app.routes.map(({ method, path }) => `${method} ${path}`);
    for (const path of [
      '/health',
      '/v1/health',
      '/health/live',
      '/v1/health/live',
      '/health/ready',
      '/v1/health/ready',
    ]) {
      expect(routes.filter((route) => route === `GET ${path}`)).toHaveLength(1);
    }
    expect(routes.filter((route) => route === 'GET /v1/projects')).toHaveLength(1);
    expect(routes.filter((route) => route === 'GET /v1/mcp')).toHaveLength(1);

    const health = await app.request(url('/health'));
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: 'ok', service: 'kortix-api' });
    expect((await app.request(url('/v1/health'))).status).toBe(200);
    // Unbooted in this process (import.meta.main is false): the readiness gate
    // answers 503 until ensureSchema resolves.
    expect((await app.request(url('/health/ready'))).status).toBe(503);
    expect((await app.request(url('/v1/health/ready'))).status).toBe(503);
    expect((await app.request(url('/v1/health/live'))).status).toBe(200);
    expect((await app.request(url('/health/live'))).status).toBe(200);
  });

  test('/metrics answers 401 without the internal key', async () => {
    const res = await app.request(url('/metrics'));
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('unauthorized\n');
  });

  test('the installed onError handler preserves status and body shapes', async () => {
    const handler = (app as any).errorHandler;
    expect(typeof handler).toBe('function');
    const errorApp = new (app.constructor as any)();
    errorApp.onError(handler);
    errorApp.get('/http-exception', () => {
      throw new HTTPException(503, { message: 'temporarily unavailable' });
    });
    errorApp.get('/typed-denial', () => {
      throw new HTTPException(403, {
        message: 'denied',
        res: Response.json({ code: 'typed_denial' }, { status: 403 }),
      });
    });
    errorApp.get('/git-transient', () => {
      throw new GitOperationError({
        kind: 'failed',
        // The transient private-mirror 404 shape (isTransientGitMirrorError).
        message: "fatal: repository 'https://example.com/x/y.git/' not found",
        gitArgs: ['clone', '--bare', 'https://example.com/x/y.git', '/tmp/x.git'],
      });
    });
    errorApp.get('/unexpected', () => {
      throw new Error('unexpected boom');
    });

    const failure = await errorApp.request(url('/http-exception'));
    expect(failure.status).toBe(503);
    expect(failure.headers.get('retry-after')).toBe('10');
    expect(await failure.json()).toEqual({
      error: true,
      message: 'temporarily unavailable',
      status: 503,
    });

    // An HTTPException built with an explicit `res` carries the thrower's body.
    const denied = await errorApp.request(url('/typed-denial'));
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ code: 'typed_denial' });

    // A transient git-mirror failure is a retryable 503, not an opaque 500.
    const git = await errorApp.request(url('/git-transient'));
    expect(git.status).toBe(503);
    expect(git.headers.get('retry-after')).toBe('10');
    expect(await git.json()).toEqual({
      error: true,
      code: 'git_mirror_unavailable',
      message: 'git mirror is temporarily unavailable',
      status: 503,
    });

    // Anything else stays a generic 500.
    const unexpected = await errorApp.request(url('/unexpected'));
    expect(unexpected.status).toBe(500);
    expect(await unexpected.json()).toEqual({
      error: true,
      message: 'Internal server error',
      status: 500,
    });
  });

  test('the not-found handler keeps the JSON 404 shape', async () => {
    const missing = await app.request(url('/missing-index-split'));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: true, message: 'Not found', status: 404 });
  });

  test('the edge disables idleTimeout and applies per-request stream timeouts', async () => {
    expect(server.idleTimeout).toBe(0);
    expect(server.websocket.idleTimeout).toBe(0);

    // WS upgrade on the tunnel edge before the schema is ready: 503 + Retry-After.
    const tunnel = await server.fetch(new Request(url('/v1/tunnel/ws'), { headers: { upgrade: 'websocket' } }), edge);
    expect(tunnel?.status).toBe(503);
    expect(tunnel?.headers.get('retry-after')).toBe('5');

    // Path-preview WS upgrade hits the same readiness gate.
    const preview = await server.fetch(
      new Request(url('/v1/p/sandbox/8000/terminal'), { headers: { upgrade: 'websocket' } }),
      edge,
    );
    expect(preview?.status).toBe(503);

    // Stream-class prefixes hand the per-request budget to the upstream.
    await server.fetch(new Request(url('/v1/llm-gateway/missing')), edge);
    await server.fetch(new Request(url('/v1/p/sandbox/8000/')), edge);
    expect(edgeCalls.filter((seconds) => seconds === 0).length).toBeGreaterThanOrEqual(3);
  });
});
