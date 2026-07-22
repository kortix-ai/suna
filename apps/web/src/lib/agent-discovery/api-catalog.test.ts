import { describe, expect, test } from 'bun:test';

import { GET } from '@/app/(public)/well-known/api-catalog/route';
import { API_BASE, AGENT_INDEX_URL, API_HEALTH_URL, OPENAPI_URL } from './endpoints';
import { buildApiCatalog } from './api-catalog';

describe('api catalog', () => {
  test('is a linkset with one entry per discoverable API', () => {
    const catalog = buildApiCatalog();
    expect(Array.isArray(catalog.linkset)).toBe(true);
    expect(catalog.linkset.map((entry) => entry.anchor)).toEqual([
      API_BASE,
      AGENT_INDEX_URL,
    ]);
  });

  test('the REST API entry points at the real spec, docs and health endpoint', () => {
    const [rest] = buildApiCatalog().linkset;
    expect(rest['service-desc']).toEqual([
      { href: OPENAPI_URL, type: 'application/json' },
    ]);
    expect(rest['service-doc']).toEqual([
      { href: 'https://kortix.com/docs', type: 'text/html' },
    ]);
    expect(rest.status).toEqual([{ href: API_HEALTH_URL, type: 'application/json' }]);
  });

  test('the content index entry points at the llms.txt family', () => {
    const [, content] = buildApiCatalog().linkset;
    expect(content.describedby).toEqual([
      { href: 'https://kortix.com/llms.txt', type: 'text/plain' },
      { href: 'https://kortix.com/llms-full.txt', type: 'text/plain' },
    ]);
  });

  test('every anchor and href is an absolute https URL', () => {
    for (const entry of buildApiCatalog().linkset) {
      expect(entry.anchor.startsWith('https://')).toBe(true);
      for (const [key, targets] of Object.entries(entry)) {
        if (key === 'anchor') continue;
        for (const target of targets as { href: string }[]) {
          expect(target.href.startsWith('https://')).toBe(true);
        }
      }
    }
  });

  test('the route serves application/linkset+json', async () => {
    const response = GET();
    expect(response.headers.get('content-type')).toBe('application/linkset+json');
    expect(await response.json()).toEqual(buildApiCatalog());
  });
});
