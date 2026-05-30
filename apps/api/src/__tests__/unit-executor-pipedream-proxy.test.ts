/**
 * The Pipedream Connect-Proxy wire format — the new `request` tool's actual
 * HTTP shape. Mocks global fetch (both the OAuth token mint + the proxy call)
 * so we assert exactly what we send to Pipedream:
 *   {METHOD} /v1/connect/{project}/proxy/{base64url(target_url)}
 *            ?external_user_id=…&account_id=…
 * with the body passed straight through and the upstream status flowing back.
 * Docs: https://pipedream.com/docs/connect/api-proxy
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { runPipedreamProxy } from '../executor/pipedream';

const PD_PROJECT = process.env.PIPEDREAM_PROJECT_ID!;

interface Captured { url: string; method: string; headers: Record<string, string>; body?: string }

const realFetch = globalThis.fetch;
let calls: Captured[];
let proxyResponse: { status: number; body: string };

beforeEach(() => {
  calls = [];
  proxyResponse = { status: 200, body: JSON.stringify({ id: 42 }) };
  globalThis.fetch = (async (url: string, init: any) => {
    const u = String(url);
    // First hop: client-credentials token mint.
    if (u.includes('/v1/oauth/token')) {
      return new Response(JSON.stringify({ access_token: 'pd_tok', expires_in: 3600 }), { status: 200 });
    }
    // Second hop: the proxy call we care about.
    calls.push({ url: u, method: init.method, headers: init.headers, body: init.body });
    return new Response(proxyResponse.body, { status: proxyResponse.status });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('Connect Proxy wire format', () => {
  const TARGET = 'https://api.github.com/repos/kortix-ai/suna/issues/1/comments';

  test('builds the proxy URL with base64url target + query params, passes body through', async () => {
    const res = await runPipedreamProxy(
      'proj-x', 'github',
      { method: 'POST', url: TARGET, body: { body: 'thermo review' } },
      'apn_acct123', 'user-7',
    );
    expect(res).toEqual({ status: 200, ok: true, data: { id: 42 } });
    expect(calls).toHaveLength(1);
    const c = calls[0]!;

    const url = new URL(c.url);
    const b64 = url.pathname.split('/proxy/')[1]!;
    expect(Buffer.from(b64, 'base64url').toString('utf8')).toBe(TARGET); // round-trips the real target
    expect(url.pathname.startsWith(`/v1/connect/${PD_PROJECT}/proxy/`)).toBe(true);
    expect(url.searchParams.get('account_id')).toBe('apn_acct123');
    expect(url.searchParams.get('external_user_id')).toBe('proj-x:github:user-7');

    expect(c.method).toBe('POST');
    expect(c.headers['Authorization']).toBe('Bearer pd_tok');
    expect(c.headers['x-pd-environment']).toBeDefined();
    expect(JSON.parse(c.body!)).toEqual({ body: 'thermo review' });
  });

  test('upstream non-2xx flows back as ok:false with the real status', async () => {
    proxyResponse = { status: 404, body: JSON.stringify({ message: 'Not Found' }) };
    const res = await runPipedreamProxy('p', 'github', { method: 'GET', url: TARGET }, 'apn_1');
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
    expect(res.data).toEqual({ message: 'Not Found' });
  });

  test('rejects a missing or non-absolute url before calling out', async () => {
    expect(await runPipedreamProxy('p', 'github', { method: 'GET' }, 'apn_1')).toMatchObject({ status: 400, ok: false });
    expect(await runPipedreamProxy('p', 'github', { method: 'GET', url: '/relative' }, 'apn_1')).toMatchObject({ status: 400, ok: false });
    expect(calls).toHaveLength(0);
  });
});
