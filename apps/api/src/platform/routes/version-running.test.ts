import { afterAll, expect, spyOn, test } from 'bun:test';

const savedVersion = process.env.SANDBOX_VERSION;
delete process.env.SANDBOX_VERSION;
const { config } = await import('../../config');
const savedOverride = config.SANDBOX_VERSION_OVERRIDE;
config.SANDBOX_VERSION_OVERRIDE = '';
const { versionRouter } = await import('./version');

afterAll(() => {
  if (savedVersion === undefined) delete process.env.SANDBOX_VERSION;
  else process.env.SANDBOX_VERSION = savedVersion;
  config.SANDBOX_VERSION_OVERRIDE = savedOverride;
});

test('a populated release feed does not invent a global running image', async () => {
  const upstream = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async () => Response.json([
    { tag_name: 'v0.14.7', name: 'Stable', published_at: '2026-10-22', body: '', draft: false, prerelease: false },
  ]), { preconnect: globalThis.fetch.preconnect }));
  try {
    const latest = await versionRouter.request('/latest');
    expect(await latest.json()).toMatchObject({ version: '0.14.7', channel: 'stable' });
    const response = await versionRouter.request('/');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ version: 'none', channel: 'none' });
    const all = await versionRouter.request('/all');
    expect(await all.json()).toMatchObject({ current: { version: 'none', channel: 'none' } });
  } finally {
    upstream.mockRestore();
  }
});

test.each(['0.14.7', 'dev-12345678'])('reports the configured image tag %s without substituting a release', async (version) => {
  config.SANDBOX_VERSION_OVERRIDE = version;
  const response = await versionRouter.request('/');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ version, channel: version.startsWith('dev-') ? 'dev' : 'stable' });
  config.SANDBOX_VERSION_OVERRIDE = '';
});

test('uses the configured override when the container tag is absent', async () => {
  config.SANDBOX_VERSION_OVERRIDE = '0.14.6';
  const response = await versionRouter.request('/');
  expect(await response.json()).toEqual({ version: '0.14.6', channel: 'stable' });
  config.SANDBOX_VERSION_OVERRIDE = '';
});
