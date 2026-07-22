import { describe, expect, test } from 'bun:test';

import markdownRoutes from './markdown-routes.json';
import { getPublicContentRecords } from './public-content';

// Use-cases are excluded on purpose: `areUseCasesPublic()` reads an env var at
// runtime, and a committed static map cannot track that. Their markdown stays
// reachable at /markdown/use-cases/*.md; only Accept negotiation skips them.
function expectedRoutes(): Record<string, string> {
  const routes: Record<string, string> = {};
  for (const record of getPublicContentRecords({ includeUseCases: false })) {
    if (record.markdownPath) routes[record.htmlPath] = record.markdownPath;
  }
  return routes;
}

describe('markdown route map', () => {
  test('the committed map matches the current content records', () => {
    // Regenerate with: bun run markdown-routes:build
    expect(markdownRoutes).toEqual(expectedRoutes());
  });

  test('is not empty', () => {
    expect(Object.keys(markdownRoutes).length).toBeGreaterThan(0);
  });

  test('every key is a root-relative html path and every value a markdown path', () => {
    for (const [htmlPath, markdownPath] of Object.entries(markdownRoutes)) {
      expect(htmlPath.startsWith('/')).toBe(true);
      expect(markdownPath.startsWith('/markdown/')).toBe(true);
      expect(markdownPath.endsWith('.md')).toBe(true);
    }
  });

  test('maps the homepage and pricing, the two pages agents ask for most', () => {
    expect(markdownRoutes['/']).toBe('/markdown/index.md');
    expect(markdownRoutes['/pricing']).toBe('/markdown/pricing.md');
  });
});
