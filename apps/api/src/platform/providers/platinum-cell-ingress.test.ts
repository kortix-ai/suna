// A CELL'S AGENT IS ON 8080, AND EVERY INGRESS HAS TO KNOW THAT.
//
// routeIngress is synchronous and sees only the request, so it answers with the
// microVM agent port (8000) — correct for a microVM and wrong for a cell, whose
// worker listens on 8080. Everything a session does to its box goes through
// resolveIngress: the readiness poll, the runtime-asset refresh, every proxied
// agent call. All of them were exposed on a port nothing serves.
//
// Measured on dev 2026-09-06, session afe59171: its cell answered
// /kortix/health with runtime "ready" on 8080 for the whole run, while the
// session sat in `open-session:starting` for 167 s and finished with
// `runtime-asset refresh not delivered / unreachable`. Nothing was broken in
// the cell; the platform was knocking on the wrong door.
import { test, expect, mock, beforeEach } from 'bun:test';

process.env.ALLOWED_SANDBOX_PROVIDERS = 'platinum';
process.env.PLATINUM_API_KEY = 'pt_test_key';
process.env.PLATINUM_API_URL = 'https://api.platinum.dev';
process.env.PLATINUM_TEMPLATE = 'tpl_test';
process.env.KORTIX_URL ??= 'https://api.example.com';
process.env.DATABASE_URL ??= 'postgres://x';

let runtime = 'cell';
let rowCalls = 0;
const exposed: number[] = [];

mock.module('../../shared/platinum', () => ({
  isPlatinumConfigured: () => true,
  platinumJsonResponse: async () => { throw new Error('unexpected materialization'); },
  platinumJson: async (path: string, init: RequestInit = {}) => {
    if (path.includes('/expose')) {
      const body = JSON.parse(String(init.body ?? '{}'));
      exposed.push(body.port);
      return { url: `https://${body.port}-sbx.test`, port: body.port, public: true };
    }
    if (/^\/v1\/sandboxes\/[^/?]+$/.test(path)) {
      rowCalls += 1;
      return { id: 'sbx_x', state: 'running', runtime };
    }
    return {};
  },
}));
mock.module('../service-key', () => ({ serviceKeyForExternalId: () => 'svc_key' }));
mock.module('../sandbox-frontend-url', () => ({ sandboxFrontendBaseUrl: () => 'https://app.example.com' }));

const provider = async () => {
  const { PlatinumProvider } = await import('./platinum');
  return new PlatinumProvider();
};

beforeEach(() => { exposed.length = 0; rowCalls = 0; });

test('a CELL exposes 8080 for the agent, not 8000', async () => {
  runtime = 'cell';
  const p = await provider();
  const r = await p.resolveIngress('sbx_cell', { port: 8000, transport: 'http', path: '/kortix/health' } as never);
  expect(r.effectivePort).toBe(8080);
  expect(exposed).toEqual([8080]);
});

test('a microVM is unchanged — it still exposes 8000', async () => {
  runtime = 'microvm';
  const p = await provider();
  const r = await p.resolveIngress('sbx_vm', { port: 8000, transport: 'http', path: '/kortix/health' } as never);
  expect(r.effectivePort).toBe(8000);
  expect(exposed).toEqual([8000]);
});

test('the runtime is looked up once per box — it cannot change under a live box', async () => {
  runtime = 'cell';
  const p = await provider();
  for (let i = 0; i < 4; i++) {
    await p.resolveIngress('sbx_same', { port: 8000, transport: 'http', path: '/x' } as never);
  }
  expect(rowCalls).toBe(1);
  expect(exposed).toEqual([8080, 8080, 8080, 8080]);
});

test('a non-agent port is passed through untouched, cell or not', async () => {
  runtime = 'cell';
  const p = await provider();
  const r = await p.resolveIngress('sbx_app', { port: 3000, transport: 'http', path: '/' } as never);
  expect(r.effectivePort).toBe(3000);
  expect(exposed).toEqual([3000]);
  // No row lookup for a port that was never the agent's.
  expect(rowCalls).toBe(0);
});

// THE PREVIEW SERVER ON A CELL. The file viewer frames an HTML file from the
// static file server on 3211; a cell has one port, and serves those routes
// under /static on it. Measured on the dev stack 2026-09-10: the viewer read
// "Starting preview server…" for its whole 30 s bound.
test("a cell's 3211 is its 8080 under /static", async () => {
  runtime = 'cell';
  const p = await provider();
  const r = await p.resolveIngress('sbx_cell_static', { port: 3211, transport: 'http', path: '/open' } as never);
  expect(r.effectivePort).toBe(8080);
  expect(r.url).toBe('https://8080-sbx.test/static');
  expect(exposed).toEqual([8080]);
});
test("a microVM's 3211 is still its own static server", async () => {
  runtime = 'microvm';
  const p = await provider();
  const r = await p.resolveIngress('sbx_vm_static', { port: 3211, transport: 'http', path: '/open' } as never);
  expect(r.effectivePort).toBe(3211);
  expect(r.url).toBe('https://3211-sbx.test');
});
