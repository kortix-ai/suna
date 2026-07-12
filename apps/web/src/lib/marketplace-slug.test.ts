import { describe, expect, test } from 'bun:test';

import {
  companyIdFromSlug,
  companySlugFromId,
  itemIdToPathParts,
  marketplaceCompanyHref,
  marketplaceItemHref,
  pathPartsToItemId,
} from './marketplace-slug';

describe('companySlugFromId', () => {
  test('keeps simple ids as-is', () => {
    expect(companySlugFromId('kortix')).toBe('kortix');
  });

  test('encodes slashes in owner/repo ids', () => {
    expect(companySlugFromId('anthropics/skills')).toBe('anthropics--skills');
    expect(companySlugFromId('anthropics/knowledge-work-plugins')).toBe(
      'anthropics--knowledge-work-plugins',
    );
  });
});

describe('companyIdFromSlug', () => {
  test('round-trips encoded company ids', () => {
    for (const id of ['kortix', 'anthropics/skills', 'anthropics/knowledge-work-plugins']) {
      expect(companyIdFromSlug(companySlugFromId(id))).toBe(id);
    }
  });
});

describe('pathPartsToItemId', () => {
  test('rejoins company and single-segment item names', () => {
    expect(pathPartsToItemId('kortix', ['code-review'])).toBe('kortix:code-review');
  });

  test('rejoins multi-segment item names with slashes', () => {
    expect(pathPartsToItemId('acme', ['tools', 'pdf'])).toBe('acme:tools/pdf');
  });

  test('handles slashy company ids', () => {
    expect(pathPartsToItemId('anthropics--skills', ['pdf-tools'])).toBe(
      'anthropics/skills:pdf-tools',
    );
  });

  test('returns the company alone when there are no item segments', () => {
    expect(pathPartsToItemId('kortix', [])).toBe('kortix');
  });
});

describe('round-trip', () => {
  for (const id of [
    'kortix:code-review',
    'acme:tools/pdf',
    'anthropics/skills:pdf-tools',
    'anthropics/knowledge-work-plugins:brand-voice',
  ]) {
    test(`id survives id -> parts -> id for ${id}`, () => {
      const { company, item } = itemIdToPathParts(id);
      expect(pathPartsToItemId(company, item)).toBe(id);
    });
  }
});

describe('marketplaceItemHref', () => {
  test('builds a clean nested path', () => {
    expect(marketplaceItemHref('kortix:code-review')).toBe('/marketplace/kortix/code-review');
  });

  test('encodes slashy company ids in one segment', () => {
    expect(marketplaceItemHref('anthropics/skills:pdf-tools')).toBe(
      '/marketplace/anthropics--skills/pdf-tools',
    );
  });

  test('preserves multi-segment item names', () => {
    expect(marketplaceItemHref('acme:tools/pdf')).toBe('/marketplace/acme/tools/pdf');
  });

  test('url-encodes unsafe characters in a segment', () => {
    expect(marketplaceItemHref('acme:a b')).toBe('/marketplace/acme/a%20b');
  });
});

describe('marketplaceCompanyHref', () => {
  test('links to the company browse page', () => {
    expect(marketplaceCompanyHref('kortix')).toBe('/marketplace/kortix');
    expect(marketplaceCompanyHref('anthropics/skills')).toBe('/marketplace/anthropics--skills');
  });
});
