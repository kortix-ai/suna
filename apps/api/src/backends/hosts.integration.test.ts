import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accounts, projectBackends, projects } from '@kortix/db';
import { eq } from 'drizzle-orm';

// A backend's Kortix hosts, through the real inbound dispatcher, the real DB,
// a fake Platinum control plane and a fake Convex behind a fake private edge.
// Proves: the api and site hosts reach the machine's ports with Kortix's edge
// token, pass every method and stream bodies both ways, never forward a Kortix
// credential, strip the provider's headers, and refuse an unknown or deleted
// backend; the dashboard host is GET-only; a WebSocket upgrade resolves to the
// machine's private wss URL with the token.
process.env.KORTIX_APPS_LOCAL = 'true';

const { config } = await import('../config');
const { db } = await import('../shared/db');
const { app } = await import('../index');
const { dispatchInProcess } = await import('../inbound-dispatch');
const { backendPublicUrls, prepareBackendWsUpgrade, resolveBackendRequest } = await import('./hosts');

const TOKEN = 'synthetic-edge-token';
const seen: Array<{ port: string; method: string; path: string; token: string | null; authorization: string | null; body: string }> = [];

// Fake Convex: `/<port>/<path>` on one server, the port standing in for the
// machine port Platinum's edge would route to. No token, no answer.
const convex = Bun.serve({
  port: 0,
  hostname: '127.0.0.1', // the sandbox's localhost name refuses connections; the address always works
  async fetch(req) {
    const url = new URL(req.url);
    const [, port, ...rest] = url.pathname.split('/');
    const token = req.headers.get('x-pt-preview-token');
    if (token !== TOKEN) return new Response('token required', { status: 404, headers: { 'x-pt-edge-verdict': 'token-required' } });
    const body = req.body ? await req.text() : '';
    seen.push({ port: port!, method: req.method, path: `/${rest.join('/')}${url.search}`, token, authorization: req.headers.get('authorization'), body });
    return new Response(`port ${port} ${req.method} ${body.length}`, {
      status: 200,
      headers: {
        'content-type': 'text/plain',
        'access-control-allow-origin': req.headers.get('origin') ?? '*',
        'x-pt-edge-served': '1',
        via: '1.1 Caddy',
        'content-security-policy': 'frame-ancestors https://platinum.dev',
      },
    });
  },
});
const exposed: string[] = [];
const platinum = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(req) {
    const [, , , id, sub] = new URL(req.url).pathname.split('/');
    if (sub === 'expose') {
      const { port, public: isPublic } = (await req.json()) as { port: number; public: boolean };
      exposed.push(`${id}:${port}:${isPublic ? 'public' : 'private'}`);
      return Response.json({ port, public: isPublic, url: `${convex.url.origin}/${port}?t=${TOKEN}` });
    }
    return Response.json({ id, state: 'running' });
  },
});

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const BACKEND = crypto.randomUUID();
const GONE = crypto.randomUUID();
const EXTERNAL = `sbx-hosts-${BACKEND.slice(0, 8)}`;
const saved = { key: config.PLATINUM_API_KEY, url: config.PLATINUM_API_URL };

beforeAll(async () => {
  config.PLATINUM_API_KEY = 'pt_synthetic_backend_hosts';
  config.PLATINUM_API_URL = `http://127.0.0.1:${platinum.port}`;
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'backend-hosts-test' });
  await db.insert(projects).values({ projectId: PROJECT, accountId: ACCOUNT, name: 'backend-hosts-test', repoUrl: 'https://example.com/bh.git' });
  const base = { projectId: PROJECT, accountId: ACCOUNT, provider: 'platinum', cpu: 1, memoryGb: 1, diskGb: 10 };
  await db.insert(projectBackends).values([
    { ...base, backendId: BACKEND, name: 'main', status: 'running', externalId: EXTERNAL, ...backendPublicUrls(BACKEND), metadata: { dashboard: true } },
    { ...base, backendId: GONE, name: 'gone', status: 'deleted', externalId: 'sbx-gone', deletedAt: new Date() },
  ]);
});

afterAll(async () => {
  config.PLATINUM_API_KEY = saved.key;
  config.PLATINUM_API_URL = saved.url;
  await db.delete(projectBackends).where(eq(projectBackends.accountId, ACCOUNT));
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
  platinum.stop(true);
  convex.stop(true);
});

const host = (backendId: string, kind: 'bc' | 'bs' | 'bd') => `http://${kind}-${backendId.replaceAll('-', '')}.apps.localhost:${config.PORT}`;
const send = (url: string, init: RequestInit = {}) => dispatchInProcess(new Request(url, init), app);

describe('backend hosts', () => {
  test('GET on the api host reaches port 3210 with the edge token; provider headers are stripped', async () => {
    const res = await send(`${host(BACKEND, 'bc')}/version?x=1`, { headers: { origin: 'http://localhost:3000' } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('port 3210 GET 0');
    expect(seen.at(-1)).toMatchObject({ port: '3210', method: 'GET', path: '/version?x=1', token: TOKEN });
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
    for (const name of ['x-pt-edge-served', 'via', 'content-security-policy']) expect(res.headers.get(name)).toBeNull();
    // Every port the proxy used is exposed privately, never publicly.
    expect(exposed.filter((e) => e.startsWith(EXTERNAL)).every((e) => e.endsWith(':private'))).toBe(true);
  });

  test('POST streams its body to the site host (port 3211); a Convex credential passes, a Kortix one never does', async () => {
    const chunks = ['{"a":', '"', 'x'.repeat(200_000), '"}'];
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks.shift();
        if (next === undefined) controller.close();
        else controller.enqueue(new TextEncoder().encode(next));
      },
    });
    const res = await send(`${host(BACKEND, 'bs')}/webhooks/crm`, {
      method: 'POST',
      body,
      headers: { authorization: 'Bearer kortix_synthetic_pat_never_forwarded' },
      duplex: 'half',
    } as RequestInit);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('port 3211 POST 200008');
    expect(seen.at(-1)).toMatchObject({ port: '3211', method: 'POST', path: '/webhooks/crm', authorization: null });

    await send(`${host(BACKEND, 'bc')}/api/query`, { method: 'POST', body: '{}', headers: { authorization: 'Convex synthetic-admin-key' } });
    expect(seen.at(-1)).toMatchObject({ port: '3210', authorization: 'Convex synthetic-admin-key' });
  });

  test('an unknown or deleted backend answers 404 and reaches no machine', async () => {
    const before = seen.length;
    expect((await send(`${host(GONE, 'bc')}/version`)).status).toBe(404);
    expect((await send(`${host(crypto.randomUUID(), 'bs')}/version`)).status).toBe(404);
    expect(seen.length).toBe(before);
  });

  test('the dashboard host serves files from port 6791, GET only, framed by Kortix web only', async () => {
    const res = await send(`${host(BACKEND, 'bd')}/index.html`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('port 6791 GET 0');
    expect(res.headers.get('content-security-policy')).toBe(`frame-ancestors ${new URL(config.FRONTEND_URL).origin}`);
    expect((await send(`${host(BACKEND, 'bd')}/index.html`, { method: 'POST', body: 'x' })).status).toBe(405);
  });

  test('a WebSocket upgrade on the api host resolves to the private wss/ws URL of port 3210 with the edge token', async () => {
    const req = new Request(`${host(BACKEND, 'bc')}/api/1.46.0/sync`, {
      headers: { upgrade: 'websocket', 'sec-websocket-key': 'c3ludGhldGlj', 'sec-websocket-extensions': 'permessage-deflate' },
    });
    const url = new URL(req.url);
    const prepared = await prepareBackendWsUpgrade(req, url, resolveBackendRequest(req, url)!);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.data.url).toBe(`ws://${convex.url.host}/3210/api/1.46.0/sync`);
    expect(prepared.data.headers['x-pt-preview-token']).toBe(TOKEN);
    expect(Object.keys(prepared.data.headers).filter((name) => name.startsWith('sec-websocket-'))).toEqual([]);
    expect(prepared.data.ingress).toEqual({ sandboxId: EXTERNAL, port: 3210 });
  });
});
