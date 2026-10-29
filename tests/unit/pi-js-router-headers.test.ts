import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../../infra/cloudflare/workers/pi-js-router/worker.mjs';

const env = { TARGET_ORIGIN: 'https://upstream.example', OPEN_ACCESS: 'true' };
const request = () => new Request('https://pi-js.example/');
const baseline = {
  'strict-transport-security': 'max-age=31536000',
  'content-security-policy': "object-src 'none'; base-uri 'self'; frame-ancestors 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};
function expectBaseline(response: Response) {
  for (const [name, value] of Object.entries(baseline)) expect(response.headers.get(name)).toBe(value);
}
afterEach(() => vi.unstubAllGlobals());

describe('pi-js response security boundary', () => {
  it.each([200, 302, 404, 500])('adds the baseline to upstream status %i without changing the body', async status => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('upstream', { status })));
    const response = await worker.fetch(request(), env);
    expect(response.status).toBe(status);
    expectBaseline(response);
    expect(await response.text()).toBe('upstream');
  });

  it('preserves existing upstream policies, including stricter referrer and CSP policies', async () => {
    const headers = { ...baseline, 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'", 'strict-transport-security': 'max-age=63072000; includeSubDomains' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('data', { headers })));
    const response = await worker.fetch(request(), env);
    for (const [name, value] of Object.entries(headers)) expect(response.headers.get(name)).toBe(value);
  });

  it.each([
    [{}, '/', 503],
    [{ TARGET_ORIGIN: env.TARGET_ORIGIN }, '/', 503],
    [{ TARGET_ORIGIN: env.TARGET_ORIGIN, ACCESS_TOKEN: 'synthetic-token' }, '/', 401],
    [env, '//other.example/', 400],
    [env, '/', 502],
  ])('adds the baseline to local errors (%j, %s)', async (config, path, status) => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('unreachable')));
    const response = await worker.fetch(new Request(`https://pi-js.example${path}`), config);
    expect(response.status).toBe(status);
    expectBaseline(response);
  });

  it('passes WebSocket upgrades through without rebuilding the response', async () => {
    const response = { status: 101, webSocket: {}, headers: new Headers() };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    expect(await worker.fetch(request(), env)).toBe(response);
  });
});
