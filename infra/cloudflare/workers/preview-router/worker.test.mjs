import { afterEach, expect, test } from 'bun:test';
import worker from './worker.mjs';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

// Exercise the deployed configuration, not a separately maintained test env.
const preview = Bun.TOML.parse(await Bun.file(new URL('./wrangler.toml', import.meta.url)).text());
const apps = Bun.TOML.parse(await Bun.file(new URL('../apps-router/wrangler.toml', import.meta.url)).text());

test('staging previews forward to the same live API origin as apps', async () => {
  expect(preview.vars.STAGING_API_ORIGIN).toBe(apps.vars.STAGING_API_ORIGIN);
  let forwarded;
  globalThis.fetch = async (request) => {
    forwarded = request;
    return new Response('preview content');
  };
  const response = await worker.fetch(
    new Request('https://staging-p3000-synthetic.p.kortix.com/path?q=1'),
    { ...preview.vars, STAGING_EDGE_SECRET: 'synthetic-test-secret' },
  );
  expect(forwarded.url).toBe('https://staging-api-euw2.kortix.com/path?q=1');
  expect(response.status).toBe(200);
  expect(await response.text()).toBe('preview content');
  expect(response.headers.get('x-kortix-preview-environment')).toBe('staging');
});
