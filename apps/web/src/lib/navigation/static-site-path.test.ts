import { describe, expect, test } from 'bun:test';

import { isStaticSitePath } from './static-site-path';

describe('isStaticSitePath', () => {
  test('docs and generated files are static', () => {
    for (const href of ['/docs', '/docs/', '/docs/sdk', '/docs/project/secrets#verify', '/docs?x=1', '/sitemap.xml', '/robots.txt', '/llms.txt', '/llms-full.txt']) {
      expect(isStaticSitePath(href)).toBe(true);
    }
  });
  test('app routes, look-alikes and non-strings are not', () => {
    for (const href of ['/', '/docsearch', '/documentation', '/developers', '/changelog', 'https://x.com/docs', '/sitemap.xml.bak', undefined, { pathname: '/docs' }]) {
      expect(isStaticSitePath(href)).toBe(false);
    }
  });
});
