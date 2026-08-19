import { describe, expect, test } from 'bun:test';

import { locales } from '@/i18n/config';
import { languageAlternates, localePath, marketingMetadata } from '@/lib/seo/metadata';
import { getPublicContentRecords } from '@/lib/seo/public-content';
import { CANONICAL_ORIGIN } from '@/lib/site-metadata';

const marketingRecords = getPublicContentRecords({ includeUseCases: true }).filter(
  (record) => record.kind === 'marketing',
);

describe('marketing page metadata contract', () => {
  test('every marketing record resolves to complete page metadata', () => {
    for (const record of marketingRecords) {
      const metadata = marketingMetadata(record.htmlPath);
      const url = `${CANONICAL_ORIGIN}${record.htmlPath}`;
      expect(metadata.title, record.htmlPath).toBe(record.title);
      expect(metadata.description, record.htmlPath).toBeTruthy();
      expect(metadata.alternates?.canonical, record.htmlPath).toBe(url);
      expect(metadata.openGraph?.url, record.htmlPath).toBe(url);
      const ogImages = metadata.openGraph?.images;
      expect(Array.isArray(ogImages) ? ogImages.length : ogImages ? 1 : 0, record.htmlPath)
        .toBeGreaterThan(0);
      expect((metadata.twitter as { card?: string })?.card, record.htmlPath).toBe(
        'summary_large_image',
      );
      expect((metadata.twitter as { images?: string[] })?.images?.length, record.htmlPath)
        .toBeGreaterThan(0);
    }
  });

  test('marketing titles and descriptions are unique', () => {
    const titles = marketingRecords.map((record) => record.title);
    const descriptions = marketingRecords.map((record) => record.description);
    expect(new Set(titles).size).toBe(titles.length);
    expect(new Set(descriptions).size).toBe(descriptions.length);
  });

  test('throws for a path without a marketing record', () => {
    expect(() => marketingMetadata('/no-such-page')).toThrow();
  });
});

describe('locale-routed marketing pages', () => {
  test('localePath prefixes every non-default locale and leaves English unprefixed', () => {
    expect(localePath('en', '/')).toBe('/');
    expect(localePath('de', '/')).toBe('/de');
    expect(localePath('en', '/legal')).toBe('/legal');
    expect(localePath('fr', '/support')).toBe('/fr/support');
  });

  test('languageAlternates carries every locale plus x-default', () => {
    const languages = languageAlternates('/legal');
    for (const locale of locales) {
      expect(languages[locale], locale).toBe(
        locale === 'en' ? `${CANONICAL_ORIGIN}/legal` : `${CANONICAL_ORIGIN}/${locale}/legal`,
      );
    }
    expect(languages['x-default']).toBe(`${CANONICAL_ORIGIN}/legal`);
  });
});
