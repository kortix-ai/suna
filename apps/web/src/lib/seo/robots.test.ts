import { expect, test } from 'bun:test';

import { renderRobotsTxt } from '@/lib/seo/robots';

// KRTX-3198: `Disallow: /_next/` also blocked /_next/static/, where every
// render-blocking stylesheet and script lives, so crawlers rendered pages
// without their CSS and JS. Crawlers apply the longest matching rule, so the
// static assets and optimized images are allowed and the rest stays blocked.
test('crawlers may fetch the static assets and images a page needs to render', () => {
  const robots = renderRobotsTxt('kortix.com');
  expect(robots).toContain('Allow: /_next/static/');
  expect(robots).toContain('Allow: /_next/image');
  expect(robots).toContain('Disallow: /_next/');
});

test('a non-canonical host still disallows everything', () => {
  expect(renderRobotsTxt('dev.kortix.com')).not.toContain('Allow: /_next/static/');
});
