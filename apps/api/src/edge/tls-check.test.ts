import { beforeEach, describe, expect, mock, test } from 'bun:test';

const configState: Record<string, unknown> = {
  KORTIX_URL: 'https://api.acme.com',
  INTERNAL_KORTIX_ENV: 'dev',
  PORT: 8008,
  KORTIX_PREVIEW_BASE_DOMAIN: 'p.acme.com',
};
mock.module('../config', () => ({ config: configState }));
mock.module('../sandbox-proxy/backend', () => ({
  resolveExternalIdFromHostLabel: async () => null,
}));
mock.module('../apps/public-proxy', () => ({ loadPublicAppState: async () => null }));

const { createEdgeApp, edgeTlsCheckStatus, previewTlsCheckStatus } = await import('./tls-check');

const LABEL = 'sbx-01m0g4hxcm32bx5r1gpyzdyc1h';
const exists = async (label: string) => label === LABEL;

beforeEach(() => {
  configState.KORTIX_PREVIEW_BASE_DOMAIN = 'p.acme.com';
  configState.INTERNAL_KORTIX_ENV = 'dev';
});

describe('previewTlsCheckStatus', () => {
  test('issues for a preview host whose sandbox exists', async () => {
    expect(await previewTlsCheckStatus(`dev-p8081-${LABEL}.p.acme.com`, exists)).toBe(200);
  });

  test('refuses a hostname that is not a preview shape', async () => {
    for (const host of ['acme.com', 'api.acme.com', 'random.p.acme.com', 'dev-p8081-x.evil.com', '']) {
      expect(await previewTlsCheckStatus(host, exists)).toBe(403);
    }
  });

  test('refuses another environment’s label — it is not this instance to serve', async () => {
    expect(await previewTlsCheckStatus(`prod-p8081-${LABEL}.p.acme.com`, exists)).toBe(403);
  });

  test('a well-formed host for a sandbox that does not exist gets no certificate', async () => {
    expect(await previewTlsCheckStatus('dev-p8081-sbx-nope.p.acme.com', exists)).toBe(404);
  });

  test('a local preview needs no ACME and no lookup', async () => {
    let asked = 0;
    const counted = async () => { asked += 1; return true; };
    expect(await previewTlsCheckStatus(`p8081-${LABEL}.localhost`, counted)).toBe(200);
    expect(asked).toBe(0);
  });

  test('refuses everything when this instance serves no preview domain', async () => {
    configState.KORTIX_PREVIEW_BASE_DOMAIN = undefined;
    expect(await previewTlsCheckStatus(`dev-p8081-${LABEL}.p.acme.com`, exists)).toBe(403);
  });
});

describe('edgeTlsCheckStatus — one gate for both wildcard families', () => {
  const appExists = async () => true;

  test('answers for a preview host', async () => {
    expect(await edgeTlsCheckStatus(`dev-p8081-${LABEL}.p.acme.com`, { appExists, sandboxExists: exists })).toBe(200);
  });

  test('answers for an App host', async () => {
    expect(
      await edgeTlsCheckStatus('dev-store-aaaaaaaaaaaaaaaa.apps.acme.com', { appExists, sandboxExists: exists }),
    ).toBe(200);
  });

  test('refuses a hostname belonging to neither family', async () => {
    expect(await edgeTlsCheckStatus('anything.acme.com', { appExists, sandboxExists: exists })).toBe(403);
  });

  test('an App host for a missing App still refuses, without falling through to previews', async () => {
    expect(
      await edgeTlsCheckStatus('dev-store-aaaaaaaaaaaaaaaa.apps.acme.com', {
        appExists: async () => false,
        sandboxExists: exists,
      }),
    ).toBe(404);
  });
});

describe('GET /tls-check', () => {
  const app = createEdgeApp({ appExists: async () => true, sandboxExists: exists });

  test('200 with a body Caddy accepts', async () => {
    const res = await app.request(`/tls-check?domain=dev-p8081-${LABEL}.p.acme.com`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test('403 for a hostname this instance does not serve', async () => {
    expect((await app.request('/tls-check?domain=evil.com')).status).toBe(403);
  });

  test('403 with no domain at all', async () => {
    expect((await app.request('/tls-check')).status).toBe(403);
  });

  test('404 for a well-formed preview host with no sandbox', async () => {
    expect((await app.request('/tls-check?domain=dev-p8081-sbx-nope.p.acme.com')).status).toBe(404);
  });
});
