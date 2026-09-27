// Platinum ingress contract: every port the Kortix proxy reaches is exposed
// PRIVATELY on the Platinum edge, and the edge's HMAC preview token travels in
// the `x-pt-preview-token` header. A public exposure lets anyone who knows the
// edge hostname reach the port without the Kortix proxy's authorization.
import { beforeEach, expect, mock, test } from 'bun:test';

process.env.ALLOWED_SANDBOX_PROVIDERS = 'platinum';
process.env.PLATINUM_API_KEY = 'pt_test_key';
process.env.PLATINUM_API_URL = 'https://api.platinum.dev';
process.env.PLATINUM_TEMPLATE = 'tpl_test';
process.env.KORTIX_URL ??= 'https://api.example.com';
process.env.DATABASE_URL ??= 'postgres://x';

type Call = { path: string; method: string; body: Record<string, unknown> | null };
const calls: Call[] = [];
let sandboxExposures: Record<string, { public: boolean }> = {};

function tokenFor(port: number): string {
  return `payload-${port}.signature-${port}`;
}

mock.module('../../shared/platinum', () => ({
  isPlatinumConfigured: () => true,
  platinumJsonResponse: async () => {
    throw new Error('unexpected Platinum materialization request');
  },
  isPlatinumSandboxNotRunningError: () => false,
  PlatinumSandboxNotRunningError: class extends Error {},
  platinumJson: async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ path, method, body });
    if (path.endsWith('/expose')) {
      // Mirrors Platinum's exposePorts(): a private expose appends `?t=` to
      // the URL and returns the token beside it.
      const port = Number(body?.port);
      const isPublic = body?.public === true;
      const url = `https://${port}-01kzp370wdb8.eu-west.sbx.platinum.dev/`;
      return isPublic
        ? { port, url, public: true }
        : { port, url: `${url}?t=${tokenFor(port)}`, token: tokenFor(port), public: false };
    }
    if (method === 'GET' && /^\/v1\/sandboxes\/[^/]+$/.test(path)) {
      return { id: 'sbx_test', state: 'running', metadata: { exposures: sandboxExposures } };
    }
    return {};
  },
}));

mock.module('../service-key', () => ({ serviceKeyForExternalId: () => 'svc_key' }));
mock.module('../sandbox-frontend-url', () => ({
  sandboxFrontendBaseUrl: () => 'https://app.example.com',
}));

const { PlatinumProvider, PLATINUM_PREVIEW_TOKEN_HEADER, privateEdgeIngress, publicExposedPorts } =
  await import('./platinum');

beforeEach(() => {
  calls.length = 0;
  sandboxExposures = {};
});

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

test('resolveIngress exposes the requested port privately and never publicly', async () => {
  const provider = new PlatinumProvider();
  await provider.resolveIngress('sbx_private_a', { port: 3211, transport: 'http' });

  const exposes = calls.filter((call) => call.path.endsWith('/expose'));
  expect(exposes.length).toBeGreaterThan(0);
  for (const call of exposes) expect(call.body?.public).toBe(false);
  expect(exposes[0]!.body).toMatchObject({ port: 3211, public: false });
});

test('the preview token travels in the x-pt-preview-token header, not in the URL', async () => {
  const provider = new PlatinumProvider();
  const ingress = await provider.resolveIngress('sbx_private_b', { port: 3211, transport: 'http' });

  expect(PLATINUM_PREVIEW_TOKEN_HEADER).toBe('x-pt-preview-token');
  expect(ingress.headers).toEqual({ 'x-pt-preview-token': tokenFor(3211) });
  expect(ingress.url).toBe('https://3211-01kzp370wdb8.eu-west.sbx.platinum.dev');
  expect(ingress.url).not.toContain('?');
  expect(ingress.effectivePort).toBe(3211);
  // The edge reads `?t=` before the header; the proxy uses this to keep a
  // client's own `t` query parameter from shadowing the credential.
  expect(ingress.queryToken).toEqual({ name: 't', value: tokenFor(3211) });
});

test('opencode ports rewrite to the agent port and still carry the token', async () => {
  const provider = new PlatinumProvider();
  const ingress = await provider.resolveIngress('sbx_private_c', { port: 4096, transport: 'http' });
  expect(ingress.effectivePort).toBe(8000);
  expect(ingress.headers['x-pt-preview-token']).toBe(tokenFor(8000));
});

test('resolveEndpoint keeps the preview token beside the service-key bearer', async () => {
  const provider = new PlatinumProvider();
  const endpoint = await provider.resolveEndpoint('sbx_private_d');
  expect(endpoint.url).toBe('https://8000-01kzp370wdb8.eu-west.sbx.platinum.dev');
  expect(endpoint.headers).toMatchObject({
    'x-pt-preview-token': tokenFor(8000),
    Authorization: 'Bearer svc_key',
  });
});

test('ports an older build exposed publicly are converted to private once per sandbox', async () => {
  sandboxExposures = {
    '3211': { public: true },
    '5173': { public: true },
    '8000': { public: false },
  };
  const provider = new PlatinumProvider();
  await provider.resolveIngress('sbx_legacy', { port: 8000, transport: 'http' });
  await settle();

  const reexposed = calls
    .filter((call) => call.path === '/v1/sandboxes/sbx_legacy/expose')
    .map((call) => call.body);
  expect(reexposed).toContainEqual(expect.objectContaining({ port: 3211, public: false }));
  expect(reexposed).toContainEqual(expect.objectContaining({ port: 5173, public: false }));
  expect(reexposed.every((body) => body?.public === false)).toBe(true);

  calls.length = 0;
  await provider.resolveIngress('sbx_legacy', { port: 8000, transport: 'http' });
  await settle();
  expect(calls.filter((call) => call.method === 'GET')).toHaveLength(0);
});

test('privateEdgeIngress refuses an exposure that carries no token', () => {
  expect(() =>
    privateEdgeIngress({ port: 3211, url: 'https://3211-x.sbx.platinum.dev/', public: true }),
  ).toThrow('no preview token');
  expect(
    privateEdgeIngress({ port: 3211, url: 'https://3211-x.sbx.platinum.dev/?t=abc', public: false }),
  ).toEqual({ url: 'https://3211-x.sbx.platinum.dev', token: 'abc' });
});

test('publicExposedPorts reads only public exposures', () => {
  expect(
    publicExposedPorts({
      metadata: {
        exposures: { '3211': { public: true }, '8000': { public: false }, bad: { public: true } },
      },
    }),
  ).toEqual([3211]);
  expect(publicExposedPorts({ metadata: {} })).toEqual([]);
  expect(publicExposedPorts({})).toEqual([]);
});
