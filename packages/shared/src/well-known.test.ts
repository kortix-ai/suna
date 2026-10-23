import { expect, test } from 'bun:test';
import { wellKnownResponse } from './well-known';

test('security disclosure uses the published contact and a future expiry', async () => {
  const response = wellKnownResponse('/.well-known/security.txt');
  expect(response?.status).toBe(200);
  expect(response?.headers.get('content-type')).toBe('text/plain; charset=utf-8');
  const body = await response?.text();
  expect(body).toContain('Contact: mailto:security@kortix.com');
  const expiry = body?.match(/^Expires: (.+)$/m)?.[1];
  expect(Date.parse(expiry ?? '')).toBeGreaterThan(Date.now());
  expect(Date.parse(expiry ?? '')).toBeLessThan(Date.now() + 366 * 86400000);
  expect(body).not.toContain('Policy:');
});

test('service-only discovery lists no internal routes or public pages', async () => {
expect(await wellKnownResponse("/robots.txt")?.text()).toContain("Disallow: /");
  const sitemap = wellKnownResponse('/sitemap.xml');
  expect(sitemap?.headers.get('content-type')).toBe('application/xml; charset=utf-8');
  expect(await sitemap?.text()).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"/>');
  expect(wellKnownResponse('/unknown')).toBeNull();
});
