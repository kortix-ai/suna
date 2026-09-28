import { describe, expect, test } from 'bun:test';
import { HTTPException } from 'hono/http-exception';
import server, { app } from '../index';

const url = (path: string) => `http://localhost:${server.port}${path}`;
const inbound = (path: string, headers: Record<string, string> = {}) =>
  server.fetch(new Request(url(path), { headers }), { timeout() {}, upgrade: () => false } as any);

describe('API entrypoint characterization', () => {
  test('health, readiness and route table are mounted once', async () => {
    const routes = app.routes.map(({ method, path }) => `${method} ${path}`);
    for (const path of ['/health', '/v1/health', '/health/live', '/v1/health/live', '/health/ready', '/v1/health/ready']) {
      expect(routes.filter((route) => route === `GET ${path}`)).toHaveLength(1);
    }
    expect(routes.filter((route) => route === 'GET /v1/projects')).toHaveLength(1);
    expect((await app.request(url('/health'))).status).toBe(200);
    expect((await app.request(url('/v1/health'))).status).toBe(200);
    expect((await app.request(url('/health/ready'))).status).toBe(503);
    expect((await app.request(url('/v1/health/live'))).status).toBe(200);
  });

  test('registered error and missing-route handlers preserve status and body', async () => {
    const missing = await app.request(url('/missing-index-split'));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: true, message: 'Not found', status: 404 });
    const handler = (app as any).errorHandler;
    expect(typeof handler).toBe('function');
    const errorApp = new (app.constructor as any)();
    errorApp.onError(handler);
    errorApp.get('/failure', () => { throw new HTTPException(503, { message: 'temporarily unavailable' }); });
    errorApp.get('/denied', () => { throw new HTTPException(403, { message: 'denied', res: Response.json({ code: 'typed_denial' }, { status: 403 }) }); });
    const failure = await errorApp.request(url('/failure'));
    expect(failure.status).toBe(503);
    expect(failure.headers.get('retry-after')).toBe('10');
    expect(await failure.json()).toEqual({ error: true, message: 'temporarily unavailable', status: 503 });
    const denied = await errorApp.request(url('/denied'));
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ code: 'typed_denial' });
  });

  test('server timeouts and websocket readiness remain at the inbound edge', async () => {
    expect(server.idleTimeout).toBe(0);
    expect(server.websocket.idleTimeout).toBe(0);
    const calls: number[] = [];
    const edge = { timeout(_req: Request, seconds: number) { calls.push(seconds); }, upgrade: () => false };
    const response = await server.fetch(new Request(url('/v1/tunnel/ws'), { headers: { upgrade: 'websocket' } }), edge as any);
    expect(response?.status).toBe(503);
    expect(response?.headers.get('retry-after')).toBe('5');
    const preview = await server.fetch(new Request(url('/v1/p/sandbox/8000/terminal'), { headers: { upgrade: 'websocket' } }), edge as any);
    expect(preview?.status).toBe(503);
    expect(calls).toContain(0);
    await server.fetch(new Request(url('/v1/llm-gateway/missing')), edge as any);
    expect(calls.filter((seconds) => seconds === 0).length).toBeGreaterThanOrEqual(2);
  });
});
