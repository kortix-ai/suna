// A PI SESSION'S CREATE MUST TERMINATE, AND POST A CELL BODY EXACTLY ONCE.
//
// platinum-cell.test.ts claims the SHAPE of a cell's create body. It cannot
// claim that the provisioner ever sends it, and that gap had a bug sitting in
// it: the cell branch recursed into provisionFromTemplate with the same opts,
// so `opts.piWorker` was still true on the way back in and the branch took
// itself forever. Every pi session on dev failed with `RangeError: Maximum
// call stack size exceeded` before any sandbox was created — surfacing to the
// user as a session stuck at `failed`, with no box and nothing in the UI to
// say why (measured 2026-09-06, sessions 13648bc9, dad03445, 713c2879).
//
// A shape test cannot fail on that. This one does: it drives the real
// create() and asserts the create POST happened once, carried the cell body,
// and came back.
import { test, expect, mock, beforeEach } from 'bun:test';

process.env.ALLOWED_SANDBOX_PROVIDERS = 'platinum';
process.env.PLATINUM_API_KEY = 'pt_test_key';
process.env.PLATINUM_API_URL = 'https://api.platinum.dev';
process.env.PLATINUM_TEMPLATE = 'tpl_test';
process.env.KORTIX_URL ??= 'https://api.example.com';
process.env.DATABASE_URL ??= 'postgres://x';

const calls: { path: string; method: string; body: any }[] = [];

mock.module('../../shared/platinum', () => ({
  isPlatinumConfigured: () => true,
  platinumJsonResponse: async () => {
    throw new Error('unexpected Platinum materialization request');
  },
  platinumJson: async (path: string, init: RequestInit = {}) => {
    let body: any = null;
    try { body = init.body ? JSON.parse(String(init.body)) : null; } catch { body = null; }
    calls.push({ path, method: String(init.method ?? 'GET'), body });
    if (path.startsWith('/v1/sandboxes?')) return { id: 'sbx_cell', state: 'running' };
    if (path.includes('/expose')) return { url: 'https://sbx.test/cell', port: 8080, public: true };
    return {};
  },
}));
mock.module('../service-key', () => ({ serviceKeyForExternalId: () => 'svc_key' }));
mock.module('../sandbox-frontend-url', () => ({ sandboxFrontendBaseUrl: () => 'https://app.example.com' }));

const baseOpts = {
  accountId: 'acc_1',
  userId: 'usr_1',
  name: 'pi-session-box',
  envVars: { KORTIX_TOKEN: 'tok_test', KORTIX_API_URL: 'https://api.example.com/v1' },
};

const creates = () => calls.filter((c) => c.method === 'POST' && c.path.startsWith('/v1/sandboxes?'));

beforeEach(() => { calls.length = 0; });

test('a piWorker create TERMINATES — one create POST, not a recursion', async () => {
  const { PlatinumProvider } = await import('./platinum');
  const res = await new PlatinumProvider().create({ ...baseOpts, piWorker: true } as never);
  expect(res.externalId).toBe('sbx_cell');
  // The recursion produced ZERO creates (it never reached the POST) and a
  // RangeError. One is the whole claim.
  expect(creates().length).toBe(1);
});

test('and the body it posts is the CELL body, not a microVM one', async () => {
  const { PlatinumProvider } = await import('./platinum');
  await new PlatinumProvider().create({ ...baseOpts, piWorker: true } as never);
  const body = creates()[0]?.body ?? {};
  expect(body.runtime).toBe('cell');
  expect(body.worker).toBe('pi-agent');
  expect(body.expose).toEqual([{ port: 8080, public: true }]);
  // Session variables reach the ISOLATE only when prefixed.
  expect(body.env?.CELLD_VAR_KORTIX_TOKEN).toBe('tok_test');
  expect(body.envVars).toBeUndefined();
});

test('a create WITHOUT piWorker is untouched — the branch is opt-in', async () => {
  const { PlatinumProvider } = await import('./platinum');
  await new PlatinumProvider().create({ ...baseOpts });
  const body = creates()[0]?.body ?? {};
  expect(creates().length).toBe(1);
  expect(body.runtime).toBeUndefined();
  expect(body.worker).toBeUndefined();
});
